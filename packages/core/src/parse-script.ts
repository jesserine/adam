import ts from "typescript";
import type { CodeSymbol, EdgeKind, Position, SymbolKind } from "./types";

export interface RawImport {
  specifier: string;
  kind: EdgeKind;
  typeOnly: boolean;
}

export interface ScriptFacts {
  symbols: CodeSymbol[];
  imports: RawImport[];
  envReads: string[];
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

/**
 * Parses one TypeScript or JavaScript file with the TypeScript compiler (syntax only, no type
 * check) and returns its top-level symbols, class members, module imports and env reads.
 */
export function parseScript(fileName: string, content: string): ScriptFacts {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const symbols: CodeSymbol[] = [];
  const imports: RawImport[] = [];
  const envReads = new Set<string>();
  const usedIds = new Map<string, number>();

  const pos = (offset: number): Position => {
    const lc = sf.getLineAndCharacterOfPosition(offset);
    return { line: lc.line + 1, column: lc.character };
  };

  const signatureOf = (node: ts.Node, body: ts.Node | undefined): string => {
    const start = node.getStart(sf);
    const end = body ? body.getStart(sf) : node.getEnd();
    const text = content.slice(start, end).replace(/\s+/g, " ").trim().replace(/\s*[{=]$/, "").trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  };

  const add = (
    name: string,
    kind: SymbolKind,
    node: ts.Node,
    body: ts.Node | undefined,
    exported: boolean,
    parent?: string,
  ): string => {
    let id = parent ? `${parent}.${name}` : name;
    const seen = usedIds.get(id) ?? 0;
    usedIds.set(id, seen + 1);
    if (seen > 0) id = `${id}#${seen + 1}`; // overloads and redeclarations
    symbols.push({
      id,
      name,
      kind,
      exported,
      parent,
      signature: signatureOf(node, body),
      start: pos(node.getStart(sf)),
      end: pos(node.getEnd()),
    });
    return id;
  };

  const memberName = (name: ts.PropertyName | undefined): string | undefined => {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return name.getText(sf);
  };

  const addClass = (node: ts.ClassDeclaration | ts.ClassExpression, name: string, exported: boolean) => {
    const classId = add(name, "class", node, undefined, exported);
    // A class's "signature" is its header only, not the whole body.
    const sym = symbols[symbols.length - 1];
    const header = content.slice(node.getStart(sf), node.members.pos).replace(/\s+/g, " ").trim().replace(/\s*\{$/, "");
    sym.signature = header.length > 240 ? `${header.slice(0, 237)}...` : header;
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member)) {
        const n = memberName(member.name);
        if (n) add(n, "method", member, member.body, exported, classId);
      } else if (ts.isConstructorDeclaration(member)) {
        add("constructor", "constructor", member, member.body, exported, classId);
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const n = memberName(member.name);
        if (n) add(n, "accessor", member, member.body, exported, classId);
      } else if (ts.isPropertyDeclaration(member) && member.initializer && isFunctionLike(member.initializer)) {
        const n = memberName(member.name);
        if (n) add(n, "method", member, functionBody(member.initializer), exported, classId);
      }
    }
  };

  const visitTopLevel = (stmt: ts.Statement) => {
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(stmt)) {
      add(stmt.name?.text ?? "default", "function", stmt, stmt.body, exported);
    } else if (ts.isClassDeclaration(stmt)) {
      addClass(stmt, stmt.name?.text ?? "default", exported);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      add(stmt.name.text, "interface", stmt, undefined, exported);
      symbols[symbols.length - 1].signature = `interface ${stmt.name.text}`;
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      add(stmt.name.text, "type", stmt, stmt.type, exported);
    } else if (ts.isEnumDeclaration(stmt)) {
      add(stmt.name.text, "enum", stmt, undefined, exported);
      symbols[symbols.length - 1].signature = `enum ${stmt.name.text}`;
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer && unwrap(decl.initializer);
        if (init && isFunctionLike(init)) {
          add(decl.name.text, "function", decl, functionBody(init), exported);
        } else if (init && ts.isClassExpression(init)) {
          addClass(init, decl.name.text, exported);
        } else if (exported) {
          add(decl.name.text, "variable", decl, decl.initializer, exported);
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      const expr = unwrap(stmt.expression);
      if (isFunctionLike(expr)) add("default", "function", stmt, functionBody(expr), true);
    }
  };

  for (const stmt of sf.statements) visitTopLevel(stmt);

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        !!clause?.isTypeOnly ||
        (!!clause &&
          !clause.name &&
          !!clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly));
      imports.push({ specifier: node.moduleSpecifier.text, kind: "imports", typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, kind: "re-exports", typeOnly: node.isTypeOnly });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({ specifier: node.moduleReference.expression.text, kind: "imports", typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          imports.push({ specifier: arg.text, kind: "dynamic-import", typeOnly: false });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
          imports.push({ specifier: arg.text, kind: "requires", typeOnly: false });
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      if (lit && ts.isStringLiteral(lit)) imports.push({ specifier: lit.text, kind: "imports", typeOnly: true });
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = envName(node);
      if (name) envReads.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { symbols, imports, envReads: [...envReads].sort() };
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

function isFunctionLike(expr: ts.Expression): expr is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);
}

function functionBody(expr: ts.Expression): ts.Node | undefined {
  const e = unwrap(expr);
  return isFunctionLike(e) ? e.body : undefined;
}

/** `process.env.FOO`, `process.env["FOO"]`, `import.meta.env.FOO` → `FOO`. */
function envName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  const target = node.expression;
  const isEnvObject =
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "env" &&
    ((ts.isIdentifier(target.expression) && target.expression.text === "process") ||
      ts.isMetaProperty(target.expression));
  if (!isEnvObject) return undefined;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
}
