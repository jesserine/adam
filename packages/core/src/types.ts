/** Bumped whenever the shape of the graph or cache changes, so old caches are ignored. */
export const GRAPH_VERSION = 1;

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

export type EdgeKind = "imports" | "re-exports" | "dynamic-import" | "requires";

export interface GraphEdge {
  id: string;
  /** Node id of the importing file. */
  source: string;
  /** Node id of the imported file. */
  target: string;
  kind: EdgeKind;
  /** The module specifier as written, e.g. `./db` or `@/lib/auth`. */
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
  /** Bare package imports such as `react` or `@prisma/client`. */
  packages: string[];
  /** Environment variables read via `process.env.X` or `import.meta.env.X`. */
  envReads: string[];
  /** Variable names an env-style file declares (names only, never values). */
  envDeclares: string[];
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
