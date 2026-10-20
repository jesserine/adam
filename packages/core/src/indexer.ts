import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBinaryByName, languageOf, looksBinary, SCRIPT_EXTENSIONS } from "./language";
import { parseScript, type RawImport } from "./parse-script";
import { ModuleResolver } from "./resolver";
import { countSecrets, envKeys, sensitiveReason } from "./sensitive";
import type { CodeGraph, CodeSymbol, GraphEdge, GraphNode, IndexOptions } from "./types";
import { GRAPH_VERSION } from "./types";
import { createIgnore, walk, type WalkedFile } from "./walk";

const DEFAULT_MAX_PARSE_BYTES = 1024 * 1024;
const CACHE_FILE = "cache.json";

/** What we learn from reading one file. Cached by size and mtime so unchanged files are never re-read. */
interface FileFacts {
  size: number;
  mtimeMs: number;
  hash: string;
  lines: number;
  binary: boolean;
  parsed: boolean;
  secretHints: number;
  symbols: CodeSymbol[];
  imports: RawImport[];
  envReads: string[];
  envDeclares: string[];
}

interface CacheFile {
  version: number;
  files: Record<string, FileFacts>;
}

function readCache(cacheDir: string | false): CacheFile {
  if (!cacheDir) return { version: GRAPH_VERSION, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, CACHE_FILE), "utf8")) as CacheFile;
    if (parsed.version === GRAPH_VERSION && parsed.files) return parsed;
  } catch {
    // Missing or corrupt cache: start fresh.
  }
  return { version: GRAPH_VERSION, files: {} };
}

function writeCache(cacheDir: string | false, cache: CacheFile): void {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, CACHE_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, target);
  } catch {
    // A read-only checkout still gets a graph, just without the cache.
  }
}

async function readFacts(file: WalkedFile, maxParseBytes: number): Promise<FileFacts> {
  const base: FileFacts = {
    size: file.size,
    mtimeMs: file.mtimeMs,
    hash: "",
    lines: 0,
    binary: false,
    parsed: false,
    secretHints: 0,
    symbols: [],
    imports: [],
    envReads: [],
    envDeclares: [],
  };
  const sensitive = sensitiveReason(file.rel) !== undefined;

  if (isBinaryByName(file.rel)) return { ...base, binary: true };

  const buffer = await fs.promises.readFile(file.abs);
  if (looksBinary(buffer)) return { ...base, binary: true };

  const content = buffer.toString("utf8");
  const lines = content.length === 0 ? 0 : content.split("\n").length;

  // Secrets never reach the cache: no hash (it could be brute-forced), no content-derived facts
  // beyond the names an env file declares.
  if (sensitive) {
    const envLike = languageOf(file.rel) === "dotenv" || file.rel.endsWith(".tfvars");
    return { ...base, lines, envDeclares: envLike ? envKeys(content) : [] };
  }

  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const secretHints = countSecrets(content);
  const ext = path.extname(file.rel).toLowerCase();
  if (!SCRIPT_EXTENSIONS.has(ext) || file.size > maxParseBytes) return { ...base, hash, lines, secretHints };

  const facts = parseScript(file.rel, content);
  return { ...base, hash, lines, secretHints, parsed: true, ...facts };
}

/**
 * Indexes a repository into a code graph. Every file becomes a node; TypeScript and JavaScript
 * files are parsed for symbols, imports and env reads, and imports are resolved to edges.
 * Unchanged files are served from `.adam/cache.json`, so re-indexing after an edit is cheap.
 */
export async function indexRepository(options: IndexOptions): Promise<CodeGraph> {
  const started = Date.now();
  const root = path.resolve(options.root);
  const maxParseBytes = options.maxParseBytes ?? DEFAULT_MAX_PARSE_BYTES;
  const cacheDir = options.cacheDir === undefined ? path.join(root, ".adam") : options.cacheDir;

  const files = await walk(root, createIgnore(root, options.ignore));
  const cache = readCache(cacheDir);
  const nextCache: CacheFile = { version: GRAPH_VERSION, files: {} };
  let reparsed = 0;

  const facts = new Map<string, FileFacts>();
  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (file) => {
        const cached = cache.files[file.rel];
        if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached;
        reparsed++;
        try {
          return await readFacts(file, maxParseBytes);
        } catch {
          return undefined; // Unreadable (permissions, deleted mid-walk): skip.
        }
      }),
    );
    batch.forEach((file, j) => {
      const f = results[j];
      if (!f) return;
      facts.set(file.rel, f);
      nextCache.files[file.rel] = f;
    });
  }

  const nodeIds = new Set(facts.keys());
  const resolver = new ModuleResolver(root, nodeIds);
  const nodes: GraphNode[] = [];
  const edgesById = new Map<string, GraphEdge>();

  for (const [rel, f] of facts) {
    const reason = sensitiveReason(rel);
    const packages = new Set<string>();
    const unresolved = new Set<string>();

    for (const imp of f.imports) {
      const r = resolver.resolve(rel, imp.specifier);
      if (r.kind === "package") packages.add(r.name);
      else if (r.kind === "unresolved") unresolved.add(imp.specifier);
      else if (r.target !== rel) {
        const id = `${rel}->${r.target}:${imp.kind}`;
        const existing = edgesById.get(id);
        if (existing) {
          // A value import wins over a type-only one for the same pair.
          if (!imp.typeOnly) existing.typeOnly = false;
          continue;
        }
        edgesById.set(id, { id, source: rel, target: r.target, kind: imp.kind, specifier: imp.specifier, typeOnly: imp.typeOnly });
      }
    }

    const slash = rel.lastIndexOf("/");
    nodes.push({
      id: rel,
      name: slash === -1 ? rel : rel.slice(slash + 1),
      folder: slash === -1 ? "" : rel.slice(0, slash),
      ext: path.extname(rel).toLowerCase(),
      language: languageOf(rel),
      size: f.size,
      lines: f.lines,
      hash: f.hash,
      binary: f.binary,
      sensitive: reason !== undefined,
      sensitiveReason: reason,
      secretHints: f.secretHints,
      parsed: f.parsed,
      symbols: f.symbols,
      packages: [...packages].sort(),
      envReads: f.envReads,
      envDeclares: f.envDeclares,
      unresolved: [...unresolved].sort(),
    });
  }

  writeCache(cacheDir, nextCache);
  const edges = [...edgesById.values()];

  return {
    version: GRAPH_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      parsed: nodes.filter((n) => n.parsed).length,
      sensitive: nodes.filter((n) => n.sensitive).length,
      reparsed,
      durationMs: Date.now() - started,
    },
  };
}
