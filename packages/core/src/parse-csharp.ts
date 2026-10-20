import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { CodeSymbol, Position, SymbolKind } from "./types";

/**
 * What a C# file says about its place in the code graph. Edges come from these later, once
 * every file is known: a type reference only becomes an edge when it resolves to a repo file.
 */
export interface CSharpLinks {
  /** Namespaces this file declares types in. */
  namespaces: string[];
  /** Fully qualified names of the types it declares, nested types as `Outer.Inner`. */
  types: string[];
  /** `using X;` namespaces, file scope. */
  usings: string[];
  /** `global using X;` namespaces, which apply to the whole project. */
  globalUsings: string[];
  /** `using static X;` types (a reference to X, and X's nested types are in scope). */
  staticUsings: string[];
  /** `using Alias = X;`, alias → target. Global aliases are kept separately. */
  aliases: Record<string, string>;
  globalAliases: Record<string, string>;
  /** Type names used in the file, simple or dotted, grouped by the namespace they appear in. */
  refs: Record<string, string[]>;
  /** Extension methods declared here, as `Namespace.MethodName`. */
  extensions: string[];
  /** Method names called on a receiver (`builder.AddServices()`), by namespace: candidates for extension methods. */
  calls: Record<string, string[]>;
}

export interface CSharpFacts {
  symbols: CodeSymbol[];
  envReads: string[];
  links: CSharpLinks;
}

const TYPE_KINDS: Record<string, SymbolKind> = {
  class_declaration: "class",
  struct_declaration: "class",
  record_declaration: "class",
  record_struct_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  delegate_declaration: "type",
};

const MEMBER_KINDS: Record<string, SymbolKind> = {
  method_declaration: "method",
  operator_declaration: "method",
  conversion_operator_declaration: "method",
  destructor_declaration: "method",
  constructor_declaration: "constructor",
  property_declaration: "accessor",
  indexer_declaration: "accessor",
  event_declaration: "accessor",
};

/** Where a declaration's header ends: the first of these child fields that is present. */
const BODY_FIELDS = ["body", "accessors", "value"];

/** Receivers that look like an `IConfiguration`: `config`, `_configuration`, `builder.Configuration`. */
const CONFIG_RECEIVER = /(^|\.)_?config(uration)?$/i;

let parserReady: Promise<Parser> | undefined;

/**
 * Locates a WebAssembly file: next to the bundle when running from `dist/` (the extension and
 * the standalone service ship both files there), otherwise from the npm package in development.
 */
function wasmPath(file: string, specifier: string): string {
  const bundled = path.join(__dirname, file);
  if (fs.existsSync(bundled)) return bundled;
  return createRequire(__filename).resolve(specifier);
}

/**
 * The C# grammar runs as WebAssembly through web-tree-sitter, so it needs no native build,
 * no .NET SDK and no per-OS binary: the same two .wasm files work wherever Node runs.
 */
function csharpParser(): Promise<Parser> {
  parserReady ??= (async () => {
    await Parser.init({ locateFile: () => wasmPath("tree-sitter.wasm", "web-tree-sitter/tree-sitter.wasm") });
    const language = await Language.load(wasmPath("tree-sitter-c_sharp.wasm", "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm"));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserReady;
}

/**
 * Parses one C# file (syntax only, no compilation) and returns its types and members, the
 * namespaces and usings that place it, the type names it refers to, and the environment
 * variables and configuration keys it reads.
 */
export async function parseCSharp(content: string): Promise<CSharpFacts> {
  const parser = await csharpParser();
  const tree = parser.parse(content);
  if (!tree) throw new Error("C# parser returned no tree");
  try {
    return extract(tree.rootNode, content);
  } finally {
    tree.delete(); // Trees live in WebAssembly memory, which is not garbage collected.
  }
}

function extract(root: Node, content: string): CSharpFacts {
  const symbols: CodeSymbol[] = [];
  const usedIds = new Map<string, number>();
  const envReads = new Set<string>();
  const namespaces = new Set<string>();
  const types: string[] = [];
  const usings = new Set<string>();
  const globalUsings = new Set<string>();
  const staticUsings = new Set<string>();
  const aliases: Record<string, string> = {};
  const globalAliases: Record<string, string> = {};
  const refs = new Map<string, Set<string>>();
  const calls = new Map<string, Set<string>>();
  const extensions = new Set<string>();

  const pos = (node: Node, end = false): Position => {
    const p = end ? node.endPosition : node.startPosition;
    return { line: p.row + 1, column: p.column };
  };

  const signatureOf = (node: Node): string => {
    // Attributes stay in the symbol's code but not in its one-line signature.
    const first = node.children.find((c) => c && c.type !== "attribute_list");
    const start = first ? first.startIndex : node.startIndex;
    const body = BODY_FIELDS.map((f) => node.childForFieldName(f)).find((c) => c);
    const end = body ? body.startIndex : node.endIndex;
    const text = content
      .slice(start, end)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*(\{|=>|;|=)$/, "")
      .trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  };

  const add = (name: string, kind: SymbolKind, node: Node, exported: boolean, parent?: string): string => {
    let id = parent ? `${parent}.${name}` : name;
    const seen = usedIds.get(id) ?? 0;
    usedIds.set(id, seen + 1);
    if (seen > 0) id = `${id}#${seen + 1}`; // overloads and partial declarations
    symbols.push({ id, name, kind, exported, parent, signature: signatureOf(node), start: pos(node), end: pos(node, true) });
    return id;
  };

  const addTo = (map: Map<string, Set<string>>, ns: string, name: string) => {
    // Types and methods are PascalCase by convention; skipping lower-case names drops locals and parameters.
    if (!/^\p{Lu}/u.test(name)) return;
    let set = map.get(ns);
    if (!set) map.set(ns, (set = new Set()));
    set.add(name);
  };
  const addRef = (ns: string, name: string) => addTo(refs, ns, name);

  const usingDirective = (node: Node) => {
    const text = node.text;
    const isGlobal = /^global\s/.test(text);
    const alias = node.childForFieldName("name");
    const target = node.namedChildren.find((c) => c && c.id !== alias?.id && isNameNode(c));
    if (!target) return;
    const name = dottedName(target);
    if (alias) (isGlobal ? globalAliases : aliases)[alias.text] = name;
    else if (/\bstatic\s/.test(text)) staticUsings.add(name);
    else (isGlobal ? globalUsings : usings).add(name);
  };

  /** Collects type names referenced anywhere below `node`. */
  const collectRefs = (node: Node, ns: string) => {
    switch (node.type) {
      case "using_directive":
      case "file_scoped_namespace_declaration":
      case "comment":
      case "string_literal":
      case "verbatim_string_literal":
      case "raw_string_literal":
        return;
      case "qualified_name":
      case "generic_name":
        // `x.Method<T>()` names a method, not a type; its type arguments still count.
        if (!(node.type === "generic_name" && node.parent?.type === "member_access_expression" && node.parent.childForFieldName("name")?.id === node.id)) {
          addRef(ns, dottedName(node));
        }
        for (const args of descendantsOfType(node, "type_argument_list")) collectRefs(args, ns);
        return;
      case "identifier": {
        const parent = node.parent;
        if (!parent) return;
        if (parent.type === "attribute") {
          addRef(ns, node.text);
          addRef(ns, `${node.text}Attribute`);
          return;
        }
        // A declared name (class, method, variable, parameter) or a member after a dot is not a type use.
        if (parent.childForFieldName("name")?.id === node.id) return;
        addRef(ns, node.text);
        return;
      }
      case "invocation_expression":
        invocation(node, ns);
        break;
      case "element_access_expression": {
        const receiver = node.childForFieldName("expression");
        const key = singleStringArgument(node.childForFieldName("subscript"));
        if (receiver && key && CONFIG_RECEIVER.test(receiver.text)) envReads.add(key);
        break;
      }
    }
    for (const child of node.namedChildren) if (child) collectRefs(child, ns);
  };

  /** `receiver.Method(...)`: a possible extension method call, and maybe an env or config read. */
  const invocation = (node: Node, ns: string) => {
    const fn = node.childForFieldName("function");
    if (fn?.type !== "member_access_expression") return;
    const member = fn.childForFieldName("name");
    const method = member?.type === "generic_name" ? member.namedChild(0)?.text : member?.text;
    if (method) addTo(calls, ns, method);
    const arg = singleStringArgument(node.childForFieldName("arguments"));
    if (!method || !arg) return;
    const receiver = fn.childForFieldName("expression")?.text ?? "";
    if (method === "GetEnvironmentVariable") envReads.add(arg);
    else if (method === "GetConnectionString") envReads.add(`ConnectionStrings:${arg}`);
    else if ((method === "GetValue" || method === "GetSection" || method === "GetRequiredSection") && CONFIG_RECEIVER.test(receiver)) {
      envReads.add(arg);
    }
  };

  const visitType = (node: Node, ns: string, outer: string | undefined, parentId: string | undefined, parentIsInterface: boolean) => {
    const kind = TYPE_KINDS[node.type];
    const name = node.childForFieldName("name")?.text ?? "?";
    const qualified = outer ? `${outer}.${name}` : ns ? `${ns}.${name}` : name;
    types.push(qualified);
    if (ns) namespaces.add(ns);
    const id = add(name, kind, node, isPublic(node, parentIsInterface), parentId);
    const body = node.childForFieldName("body");
    if (!body || node.type === "enum_declaration") return;
    const isInterface = node.type === "interface_declaration";
    const isStatic = hasModifier(node, "static");
    for (const member of body.namedChildren) {
      if (!member) continue;
      if (TYPE_KINDS[member.type]) {
        visitType(member, ns, qualified, id, isInterface);
      } else if (MEMBER_KINDS[member.type]) {
        const memberId = memberName(member, name);
        add(memberId, MEMBER_KINDS[member.type], member, isPublic(member, isInterface), id);
        if (isStatic && member.type === "method_declaration" && isExtensionMethod(member)) extensions.add(join(ns, memberId));
      }
    }
  };

  /** Walks declarations, tracking the namespace each one sits in. */
  const visitScope = (container: Node, ns: string) => {
    let current = ns;
    for (const child of container.namedChildren) {
      if (!child) continue;
      if (child.type === "using_directive") {
        usingDirective(child);
      } else if (child.type === "file_scoped_namespace_declaration") {
        current = join(ns, dottedName(child.childForFieldName("name")));
        namespaces.add(current);
      } else if (child.type === "namespace_declaration") {
        const inner = join(current, dottedName(child.childForFieldName("name")));
        namespaces.add(inner);
        const body = child.childForFieldName("body");
        if (body) visitScope(body, inner);
        continue; // the body's refs were collected by the nested visit
      } else if (TYPE_KINDS[child.type]) {
        visitType(child, current, undefined, undefined, false);
      }
      collectRefs(child, current);
    }
  };

  visitScope(root, "");
  for (const s of staticUsings) addRef("", s);

  return {
    symbols,
    envReads: [...envReads].sort(),
    links: {
      namespaces: [...namespaces].sort(),
      types,
      usings: [...usings].sort(),
      globalUsings: [...globalUsings].sort(),
      staticUsings: [...staticUsings].sort(),
      aliases,
      globalAliases,
      refs: byNamespace(refs),
      extensions: [...extensions].sort(),
      calls: byNamespace(calls),
    },
  };
}

function memberName(member: Node, typeName: string): string {
  switch (member.type) {
    case "indexer_declaration":
      return "this[]";
    case "destructor_declaration":
      return `~${typeName}`;
    case "operator_declaration":
      return `operator ${member.childForFieldName("operator")?.text ?? "?"}`;
    case "conversion_operator_declaration":
      return `operator ${member.childForFieldName("type")?.text ?? "?"}`;
    default:
      return member.childForFieldName("name")?.text ?? "?";
  }
}

function hasModifier(node: Node, modifier: string): boolean {
  return node.namedChildren.some((c) => c?.type === "modifier" && c.text === modifier);
}

function isPublic(node: Node, parentIsInterface: boolean): boolean {
  return parentIsInterface || hasModifier(node, "public");
}

/** A method whose first parameter is `this T`. */
function isExtensionMethod(method: Node): boolean {
  const first = method.childForFieldName("parameters")?.namedChildren.find((c) => c?.type === "parameter");
  return !!first && hasModifier(first, "this");
}

function byNamespace(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...map].map(([ns, names]) => [ns, [...names].sort()]));
}

function isNameNode(node: Node): boolean {
  return node.type === "identifier" || node.type === "qualified_name" || node.type === "generic_name" || node.type === "alias_qualified_name";
}

/** `A.B.C`, `List<T>` → `List`, `global::A.B` → `A.B`. */
function dottedName(node: Node | null): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.text;
    case "generic_name":
      return node.namedChild(0)?.text ?? "";
    case "qualified_name":
      return join(dottedName(node.childForFieldName("qualifier")), dottedName(node.childForFieldName("name")));
    case "alias_qualified_name":
      return dottedName(node.childForFieldName("name"));
    default:
      return node.text.replace(/\s+/g, "");
  }
}

function join(a: string, b: string): string {
  return a && b ? `${a}.${b}` : a || b;
}

function descendantsOfType(node: Node, type: string): Node[] {
  return node.descendantsOfType(type).filter((n): n is Node => !!n);
}

/** The text of a lone plain string argument: `("KEY")` or `["KEY"]`. Interpolated strings don't count. */
function singleStringArgument(list: Node | null): string | undefined {
  const args = list?.namedChildren.filter((c): c is Node => !!c && c.type === "argument") ?? [];
  if (args.length !== 1) return undefined;
  const value = args[0].namedChildren.find((c) => c && c.type !== "name_colon");
  if (value?.type === "string_literal") {
    const parts = value.namedChildren;
    if (parts.every((p) => p?.type === "string_literal_content")) return parts.map((p) => p!.text).join("") || undefined;
  } else if (value?.type === "verbatim_string_literal") {
    return value.text.slice(2, -1) || undefined;
  }
  return undefined;
}
