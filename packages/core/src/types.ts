/** Bumped whenever the shape of the graph or cache changes, so old caches are ignored. */
export const GRAPH_VERSION = 2;

export interface Position {
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  column: number;
}

export type SymbolKind =
  | "function"
  | "method"
  | "constructor"
  | "accessor"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable";

/** A function, method, class or type inside a node. The UI shows these collapsed by default. */
export interface CodeSymbol {
  /** Unique within its node, e.g. `UserService.create`. */
  id: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  /** Id of the enclosing class, when the symbol is a member. */
  parent?: string;
  /** The declaration's header (everything before its body), trimmed. */
  signature: string;
  start: Position;
  end: Position;
}

export type EdgeKind =
  | "imports"
  | "re-exports"
  | "dynamic-import"
  | "requires"
  /** C#: the source uses a type (or calls an extension method) declared in the target. */
  | "references"
  /** C#: the source declares another part of a partial type declared in the target. */
  | "partial"
  /** .NET: a project's `<ProjectReference>` to another project. */
  | "project-reference"
  /** .NET: a solution lists the project. */
  | "solution-project";

export interface GraphEdge {
  id: string;
  /** Node id of the importing (or referencing) file. */
  source: string;
  /** Node id of the imported file. */
  target: string;
  kind: EdgeKind;
  /** The module specifier as written, e.g. `./db` or `@/lib/auth`; for C#, the type names used. */
  specifier: string;
  /** True for `import type` / `export type` edges, which vanish at runtime. */
  typeOnly: boolean;
}

/** Any file in the repository, whatever its extension. */
export interface GraphNode {
  /** Repo-relative path with forward slashes. Also the node's id. */
  id: string;
  name: string;
  /** Repo-relative folder, `""` for the root. */
  folder: string;
  ext: string;
  language: string;
  size: number;
  lines: number;
  hash: string;
  binary: boolean;
  /** Held secrets or protected config: content is never sent anywhere unmasked. */
  sensitive: boolean;
  sensitiveReason?: string;
  /** Count of secret-looking values found in an otherwise ordinary file. They are masked when served. */
  secretHints: number;
  /** True when the file was parsed for symbols and imports. */
  parsed: boolean;
  symbols: CodeSymbol[];
  /**
   * Bare package imports such as `react` or `@prisma/client`; NuGet packages for a .NET project
   * file; namespaces from outside the repo for a C# file (`System.Text.Json`).
   */
  packages: string[];
  /**
   * Environment variables read via `process.env.X`, `import.meta.env.X` or
   * `Environment.GetEnvironmentVariable("X")`, plus .NET configuration keys read through
   * `IConfiguration` (`Jwt:Key`, `ConnectionStrings:Default`).
   */
  envReads: string[];
  /** Keys an env-style or settings file declares (names only, never values), e.g. `Jwt:Key` for appsettings. */
  envDeclares: string[];
  /** For a C# file, the `.csproj` that owns it. */
  project?: string;
  /** Imports that look local but did not resolve to a file in the repo. */
  unresolved: string[];
}

export interface GraphStats {
  nodes: number;
  edges: number;
  parsed: number;
  sensitive: number;
  /** Files re-read and re-parsed in this run (the rest came from the cache). */
  reparsed: number;
  durationMs: number;
}

export interface CodeGraph {
  version: number;
  root: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface IndexOptions {
  /** Absolute path of the repository root. */
  root: string;
  /** Files larger than this are kept as nodes but not parsed. Default 1 MiB. */
  maxParseBytes?: number;
  /** Extra ignore patterns in .gitignore syntax. */
  ignore?: string[];
  /** Directory for the incremental cache. Default `<root>/.adam`. Set to `false` to disable. */
  cacheDir?: string | false;
}
