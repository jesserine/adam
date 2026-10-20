import * as path from "node:path";
import ts from "typescript";

export type Resolution =
  | { kind: "file"; target: string }
  | { kind: "package"; name: string }
  | { kind: "unresolved" };

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.Preserve,
};

/** Options we always add: the graph needs JS and JSON edges even where the project's build does not. */
const FORCED_OPTIONS: ts.CompilerOptions = { allowJs: true, resolveJsonModule: true, noEmit: true };

interface ConfigEntry {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
}

/**
 * Resolves import specifiers to files the way the project's own TypeScript config would,
 * using the nearest tsconfig.json or jsconfig.json (so path aliases like `@/lib` work in
 * monorepos where each package has its own config).
 */
export class ModuleResolver {
  private readonly configByDir = new Map<string, string | undefined>();
  private readonly entries = new Map<string, ConfigEntry>();

  constructor(
    private readonly root: string,
    private readonly nodeIds: ReadonlySet<string>,
  ) {}

  resolve(fromRel: string, specifier: string): Resolution {
    const fromAbs = path.join(this.root, fromRel);
    const fromDir = path.dirname(fromAbs);
    const isRelative = specifier.startsWith(".") || specifier.startsWith("/");

    // Non-script assets (css, svg, json, images) by plain path first.
    if (isRelative) {
      const direct = this.toNodeId(path.resolve(fromDir, specifier));
      if (direct && !/\.[mc]?[jt]sx?$/.test(direct)) return { kind: "file", target: direct };
    }

    const entry = this.entryFor(fromDir);
    const result = ts.resolveModuleName(specifier, fromAbs, entry.options, ts.sys, entry.cache);
    const resolved = result.resolvedModule;
    if (resolved) {
      // node_modules is never indexed, so a hit on an indexed file is a real repo file, even when
      // TypeScript reached it through a workspace symlink (monorepo packages importing each other).
      const id = this.toNodeId(resolved.resolvedFileName);
      if (id) return { kind: "file", target: id };
      if (resolved.isExternalLibraryImport || resolved.resolvedFileName.includes(`${path.sep}node_modules${path.sep}`)) {
        return { kind: "package", name: packageName(specifier) };
      }
    }

    if (isRelative || /^[~#@]\//.test(specifier) || specifier.startsWith("#")) return { kind: "unresolved" };
    return { kind: "package", name: packageName(specifier) };
  }

  private toNodeId(abs: string): string | undefined {
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return this.nodeIds.has(rel) ? rel : undefined;
  }

  private entryFor(dir: string): ConfigEntry {
    const configPath = this.findConfig(dir);
    const key = configPath ?? "<default>";
    let entry = this.entries.get(key);
    if (!entry) {
      const options = { ...(configPath ? readOptions(configPath) : DEFAULT_OPTIONS), ...FORCED_OPTIONS };
      const cwd = configPath ? path.dirname(configPath) : this.root;
      entry = { options, cache: ts.createModuleResolutionCache(cwd, (s) => s, options) };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private findConfig(dir: string): string | undefined {
    if (this.configByDir.has(dir)) return this.configByDir.get(dir);
    let found: string | undefined;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(dir, name);
      if (ts.sys.fileExists(candidate)) {
        found = candidate;
        break;
      }
    }
    const parent = path.dirname(dir);
    const insideRoot = !path.relative(this.root, parent).startsWith("..");
    if (!found && dir !== this.root && parent !== dir && insideRoot) found = this.findConfig(parent);
    this.configByDir.set(dir, found);
    return found;
  }
}

function readOptions(configPath: string): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) return DEFAULT_OPTIONS;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
  const options = { ...parsed.options };
  // Node-style resolution without an explicit setting: fall back to bundler semantics, which
  // accept extensionless relative imports as written in most apps.
  if (options.moduleResolution === undefined) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    options.module = ts.ModuleKind.ESNext;
  }
  return options;
}

/** `@scope/pkg/sub` → `@scope/pkg`, `lodash/fp` → `lodash`, `node:fs` → `node:fs`. */
export function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}
