import * as path from "node:path";
import type { CSharpLinks } from "./parse-csharp";
import type { GraphEdge } from "./types";

/** What a project (`.csproj`) or solution (`.sln`, `.slnx`) file declares. */
export interface MsBuildFacts {
  /** `<ProjectReference Include>` paths, or a solution's project paths, as written. */
  references: string[];
  /** `<PackageReference Include>` NuGet package names. */
  packages: string[];
  /** `<Using Include>` items: global usings for every file in the project. */
  usings: string[];
}

/**
 * Namespaces the .NET SDKs import implicitly (`<ImplicitUsings>enable</ImplicitUsings>`, the
 * default in new projects), across the base, Web and Worker SDKs. Repos often declare extension
 * classes in these namespaces precisely so they need no using, so lookup always includes them.
 */
const IMPLICIT_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.IO",
  "System.Linq",
  "System.Net.Http",
  "System.Net.Http.Json",
  "System.Threading",
  "System.Threading.Tasks",
  "Microsoft.AspNetCore.Builder",
  "Microsoft.AspNetCore.Hosting",
  "Microsoft.AspNetCore.Http",
  "Microsoft.AspNetCore.Routing",
  "Microsoft.Extensions.Configuration",
  "Microsoft.Extensions.DependencyInjection",
  "Microsoft.Extensions.Hosting",
  "Microsoft.Extensions.Logging",
];

export const PROJECT_EXTENSIONS = new Set([".csproj", ".fsproj", ".vbproj"]);
export const SOLUTION_EXTENSIONS = new Set([".sln", ".slnx"]);

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];

function items(content: string, element: string, attribute: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(new RegExp(`<${element}\\b[^>]*>`, "gi"))) {
    const value = attr(m[0], attribute);
    if (value) out.push(...value.split(";").map((v) => v.trim()).filter(Boolean));
  }
  return out;
}

export function parseProjectFile(content: string): MsBuildFacts {
  const body = content.replace(/<!--[\s\S]*?-->/g, "");
  const packages = [...items(body, "PackageReference", "Include"), ...items(body, "PackageReference", "Update")];
  const usings = [...body.matchAll(/<Using\b[^>]*>/gi)]
    .filter((m) => !attr(m[0], "Static") && !attr(m[0], "Alias"))
    .map((m) => attr(m[0], "Include"))
    .filter((v): v is string => !!v);
  return {
    references: items(body, "ProjectReference", "Include"),
    packages: [...new Set(packages)].sort(),
    usings: [...new Set(usings)].sort(),
  };
}

/** Classic `.sln` lines (`Project("{guid}") = "Name", "src\App\App.csproj", "{guid}"`) and `.slnx` `<Project Path>`. */
export function parseSolution(content: string): MsBuildFacts {
  const references: string[] = [];
  for (const m of content.matchAll(/^\s*Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"/gm)) {
    if (/\.\w+proj$/i.test(m[1])) references.push(m[1]); // solution folders have no project file
  }
  references.push(...items(content, "Project", "Path"));
  return { references, packages: [], usings: [] };
}

/** Resolves an MSBuild path (`..\Core\Core.csproj`) against the file that wrote it. */
export function resolveMsBuildPath(fromRel: string, written: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), written.replace(/\\/g, "/")));
}

export interface DotnetFile {
  rel: string;
  csharp?: CSharpLinks;
  msbuild?: MsBuildFacts;
}

export interface DotnetLinks {
  edges: GraphEdge[];
  /** NuGet packages for project files; namespaces from outside the repo for C# files. */
  packages: Map<string, string[]>;
  /** Project paths that matched no file. */
  unresolved: Map<string, string[]>;
  /** The project file that owns each C# file. */
  project: Map<string, string>;
}

/**
 * Turns per-file .NET facts into graph edges:
 * - solution → project and project → project edges from `.sln`/`.slnx` and `<ProjectReference>`;
 * - C# file → C# file edges where a type name used in one resolves to a type declared in the
 *   other, by C# lookup rules: enclosing namespaces first, then usings, aliases and static usings,
 *   limited to the file's own project and the projects it references;
 * - the same for extension method calls (`builder.AddServices()`), matched by name against
 *   extension methods declared in a namespace the caller can see;
 * - `partial` edges between the files that declare parts of one partial type.
 */
export function linkDotnet(files: DotnetFile[], nodeIds: ReadonlySet<string>): DotnetLinks {
  const edges: GraphEdge[] = [];
  const packages = new Map<string, string[]>();
  const unresolved = new Map<string, string[]>();
  const project = new Map<string, string>();

  // MSBuild paths are case-insensitive on Windows, where most .sln files are written.
  const byLowerCase = new Map([...nodeIds].map((id) => [id.toLowerCase(), id]));

  // Project files, their references and owning directories.
  const projectRefs = new Map<string, string[]>();
  const projectDirs = new Map<string, string>();
  for (const f of files) {
    if (!f.msbuild) continue;
    const isSolution = SOLUTION_EXTENSIONS.has(path.posix.extname(f.rel).toLowerCase());
    const targets: string[] = [];
    const missing: string[] = [];
    for (const written of f.msbuild.references) {
      const wanted = resolveMsBuildPath(f.rel, written);
      const target = nodeIds.has(wanted) ? wanted : byLowerCase.get(wanted.toLowerCase());
      if (!target) {
        missing.push(written);
        continue;
      }
      if (target === f.rel || targets.includes(target)) continue;
      targets.push(target);
      const kind = isSolution ? "solution-project" : "project-reference";
      edges.push({ id: `${f.rel}->${target}:${kind}`, source: f.rel, target, kind, specifier: written, typeOnly: false });
    }
    if (missing.length) unresolved.set(f.rel, [...new Set(missing)].sort());
    if (isSolution) continue;
    projectRefs.set(f.rel, targets);
    if (f.msbuild.packages.length) packages.set(f.rel, f.msbuild.packages);
    const dir = path.posix.dirname(f.rel);
    if (!projectDirs.has(dir)) projectDirs.set(dir, f.rel);
  }

  const reachable = new Map<string, Set<string>>();
  const reachableFrom = (proj: string): Set<string> => {
    let set = reachable.get(proj);
    if (set) return set;
    set = new Set([proj]);
    reachable.set(proj, set);
    const stack = [...(projectRefs.get(proj) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (set.has(next)) continue;
      set.add(next);
      stack.push(...(projectRefs.get(next) ?? []));
    }
    return set;
  };

  const ownerOf = (rel: string): string | undefined => {
    let dir = path.posix.dirname(rel);
    for (;;) {
      const owner = projectDirs.get(dir);
      if (owner) return owner;
      if (dir === "." || dir === "") return undefined;
      const parent = path.posix.dirname(dir);
      dir = parent === dir ? "." : parent;
    }
  };

  // Type index and project-wide usings.
  const typeIndex = new Map<string, Set<string>>();
  const extensionIndex = new Map<string, Set<string>>();
  const repoNamespaces = new Set<string>();
  const projectUsings = new Map<string, { usings: Set<string>; aliases: Record<string, string> }>();
  const usingsFor = (proj: string | undefined) => {
    const key = proj ?? "";
    let entry = projectUsings.get(key);
    if (!entry) projectUsings.set(key, (entry = { usings: new Set(), aliases: {} }));
    return entry;
  };
  for (const f of files) {
    if (f.msbuild && PROJECT_EXTENSIONS.has(path.posix.extname(f.rel).toLowerCase())) {
      for (const u of f.msbuild.usings) usingsFor(f.rel).usings.add(u);
    }
    if (!f.csharp) continue;
    const owner = ownerOf(f.rel);
    if (owner) project.set(f.rel, owner);
    for (const t of f.csharp.types) addToIndex(typeIndex, t, f.rel);
    for (const m of f.csharp.extensions) addToIndex(extensionIndex, m, f.rel);
    for (const ns of f.csharp.namespaces) {
      const parts = ns.split(".");
      for (let i = 1; i <= parts.length; i++) repoNamespaces.add(parts.slice(0, i).join("."));
    }
    const shared = usingsFor(owner);
    for (const u of f.csharp.globalUsings) shared.usings.add(u);
    Object.assign(shared.aliases, f.csharp.globalAliases);
  }

  const inScope = (from: string | undefined, to: string | undefined) => !from || !to || reachableFrom(from).has(to);

  for (const f of files) {
    if (!f.csharp) continue;
    const c = f.csharp;
    const owner = project.get(f.rel);
    const shared = usingsFor(owner);
    const usings = [...new Set([...c.usings, ...shared.usings, ...IMPLICIT_USINGS])];
    const aliases = { ...shared.aliases, ...c.aliases };
    const byTarget = new Map<string, Set<string>>();

    const ownTypes = new Set(c.types);
    const link = (target: string, name: string) => {
      let set = byTarget.get(target);
      if (!set) byTarget.set(target, (set = new Set()));
      set.add(name);
    };

    /** Files in scope that declare `fqn`, or undefined when no file in scope does (keep looking). */
    const lookup = (fqn: string, index = typeIndex): string[] | undefined => {
      const inScopeFiles = [...(index.get(fqn) ?? [])].filter((t) => t === f.rel || inScope(owner, project.get(t)));
      if (!inScopeFiles.length) return undefined;
      // A type this file declares itself is not a dependency, even when other partial parts exist.
      if (index === typeIndex && ownTypes.has(fqn)) return [];
      return inScopeFiles.filter((t) => t !== f.rel);
    };

    const resolveName = (ns: string, name: string): string[] => {
      const [head, ...rest] = name.split(".");
      const aliased = aliases[head];
      if (aliased) return lookup([aliased, ...rest].join(".")) ?? [];
      // Enclosing namespaces, innermost first, then the global namespace.
      const parts = ns ? ns.split(".") : [];
      for (let i = parts.length; i >= 0; i--) {
        const hits = lookup(i ? `${parts.slice(0, i).join(".")}.${name}` : name);
        if (hits) return hits;
      }
      const viaUsings = [...usings, ...c.staticUsings].flatMap((u) => lookup(`${u}.${name}`) ?? []);
      return [...new Set(viaUsings)];
    };

    for (const [ns, names] of Object.entries(c.refs)) {
      for (const name of names) for (const target of resolveName(ns, name)) link(target, name);
    }

    // Extension methods: every namespace in scope contributes, as in C#.
    for (const [ns, names] of Object.entries(c.calls)) {
      const parts = ns ? ns.split(".") : [];
      const visible = [...parts.map((_, i) => parts.slice(0, i + 1).join(".")), ...usings];
      for (const name of names) {
        const hits = new Set(["", ...visible].flatMap((v) => lookup(v ? `${v}.${name}` : name, extensionIndex) ?? []));
        for (const target of hits) link(target, `${name}()`);
      }
    }

    for (const [target, names] of byTarget) {
      const list = [...names].sort();
      const specifier = list.length > 3 ? `${list.slice(0, 3).join(", ")} +${list.length - 3}` : list.join(", ");
      edges.push({ id: `${f.rel}->${target}:references`, source: f.rel, target, kind: "references", specifier, typeOnly: false });
    }

    const external = [...c.usings, ...c.globalUsings].filter((u) => !repoNamespaces.has(u));
    if (external.length) packages.set(f.rel, [...new Set(external)].sort());
  }

  // Partial types: link each extra part to the part with the shortest path (`Form.cs` ← `Form.Designer.cs`).
  for (const parts of typeIndex.values()) {
    if (parts.size < 2) continue;
    const byProject = new Map<string, string[]>();
    for (const rel of parts) {
      const key = project.get(rel) ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), rel]);
    }
    for (const files of byProject.values()) {
      if (files.length < 2) continue;
      const [main, ...rest] = files.sort((a, b) => a.length - b.length || a.localeCompare(b));
      for (const rel of rest) {
        const id = `${rel}->${main}:partial`;
        if (!edges.some((e) => e.id === id)) edges.push({ id, source: rel, target: main, kind: "partial", specifier: "partial", typeOnly: false });
      }
    }
  }

  return { edges, packages, unresolved, project };
}

function addToIndex(index: Map<string, Set<string>>, key: string, rel: string): void {
  let set = index.get(key);
  if (!set) index.set(key, (set = new Set()));
  set.add(rel);
}
