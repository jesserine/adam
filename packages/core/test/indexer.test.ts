import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepository, MASK, readNodeContent, readSymbolCode, type CodeGraph } from "../src";

const FIXTURE = path.join(__dirname, "fixtures", "sample-app");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "adam-core-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const node = (g: CodeGraph, id: string) => {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`missing node ${id}`);
  return n;
};
const edge = (g: CodeGraph, source: string, target: string) => g.edges.find((e) => e.source === source && e.target === target);

describe("indexRepository", () => {
  it("makes every non-ignored file a node, whatever its extension", async () => {
    const g = await indexRepository({ root });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      ".env",
      ".env.example",
      ".gitignore",
      "README.md",
      "assets/logo.png",
      "scripts/legacy.js",
      "src/index.ts",
      "src/lazy.tsx",
      "src/lib/db.ts",
      "src/missing.ts",
      "src/server.ts",
      "src/styles.css",
      "src/types.ts",
      "src/utils/index.ts",
      "tsconfig.json",
    ]);
    expect(node(g, "assets/logo.png").binary).toBe(true);
    expect(node(g, "README.md").language).toBe("markdown");
    expect(node(g, "src/lazy.tsx").language).toBe("typescript");
  });

  it("resolves relative, aliased, index, asset, dynamic and require imports to edges", async () => {
    const g = await indexRepository({ root });
    expect(edge(g, "src/index.ts", "src/server.ts")?.kind).toBe("imports");
    expect(edge(g, "src/index.ts", "src/lib/db.ts")?.specifier).toBe("@/lib/db");
    expect(edge(g, "src/index.ts", "src/utils/index.ts")?.kind).toBe("re-exports");
    expect(edge(g, "src/index.ts", "src/styles.css")?.kind).toBe("imports");
    expect(edge(g, "src/index.ts", "src/lazy.tsx")?.kind).toBe("dynamic-import");
    expect(edge(g, "scripts/legacy.js", "src/lib/db.ts")?.kind).toBe("requires");
    expect(edge(g, "src/index.ts", "src/types.ts")?.typeOnly).toBe(true);
    expect(edge(g, "src/index.ts", "src/server.ts")?.typeOnly).toBe(false);
  });

  it("links monorepo packages that import each other through workspace symlinks", async () => {
    fs.mkdirSync(path.join(root, "packages/shared/src"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/shared/package.json"), '{ "name": "@sample/shared", "main": "src/index.ts" }');
    fs.writeFileSync(path.join(root, "packages/shared/src/index.ts"), "export const shared = 1;\n");
    fs.mkdirSync(path.join(root, "node_modules/@sample"), { recursive: true });
    fs.symlinkSync(path.join(root, "packages/shared"), path.join(root, "node_modules/@sample/shared"), "junction");
    fs.writeFileSync(path.join(root, "src/uses-shared.ts"), 'import { shared } from "@sample/shared";\nexport const x = shared;\n');

    const g = await indexRepository({ root, cacheDir: false });
    expect(edge(g, "src/uses-shared.ts", "packages/shared/src/index.ts")?.specifier).toBe("@sample/shared");
    expect(node(g, "src/uses-shared.ts").packages).toEqual([]);
    expect(g.nodes.some((n) => n.id.startsWith("node_modules/"))).toBe(false);
  });

  it("records packages and unresolved imports instead of inventing edges", async () => {
    const g = await indexRepository({ root });
    expect(node(g, "src/index.ts").packages).toEqual(["react", "zod"]);
    expect(node(g, "src/server.ts").packages).toEqual(["express"]);
    expect(node(g, "src/missing.ts").unresolved).toEqual(["./nope"]);
  });

  it("extracts symbols with kinds, members and ranges", async () => {
    const g = await indexRepository({ root });
    const server = node(g, "src/server.ts");
    const byId = Object.fromEntries(server.symbols.map((s) => [s.id, s]));
    expect(Object.keys(byId)).toEqual([
      "Server",
      "Server.constructor",
      "Server.port",
      "Server.start",
      "Server.handle",
      "createServer",
    ]);
    expect(byId.Server.kind).toBe("class");
    expect(byId.Server.signature).toBe("export class Server");
    expect(byId["Server.start"]).toMatchObject({ kind: "method", parent: "Server", start: { line: 14 } });
    expect(byId["Server.port"].kind).toBe("accessor");
    expect(byId.createServer.signature).toBe("export function createServer(db: unknown): Server");

    const types = node(g, "src/types.ts").symbols.map((s) => [s.name, s.kind]);
    expect(types).toEqual([
      ["User", "interface"],
      ["Role", "type"],
      ["Status", "enum"],
    ]);
    expect(node(g, "src/lib/db.ts").symbols.map((s) => [s.name, s.kind])).toEqual([["connect", "function"]]);
    expect(node(g, "src/lazy.tsx").symbols.map((s) => s.name)).toEqual(["Lazy"]);
  });

  it("collects env reads and env declarations without values", async () => {
    const g = await indexRepository({ root });
    expect(node(g, "src/server.ts").envReads).toEqual(["PORT"]);
    expect(node(g, "src/lib/db.ts").envReads).toEqual(["DATABASE_URL"]);
    expect(node(g, "src/lazy.tsx").envReads).toEqual(["VITE_TITLE"]);
    const env = node(g, ".env");
    expect(env.sensitive).toBe(true);
    expect(env.envDeclares).toEqual(["DATABASE_URL", "API_KEY"]);
    expect(env.hash).toBe("");
    expect(node(g, ".env.example").sensitive).toBe(false);
  });

  it("flags secret-looking values in ordinary files", async () => {
    const g = await indexRepository({ root });
    expect(node(g, "src/lib/db.ts").secretHints).toBe(1);
    expect(node(g, "src/server.ts").secretHints).toBe(0);
  });

  it("re-reads only changed files on the next run, and never caches secret values", async () => {
    const first = await indexRepository({ root });
    expect(first.stats.reparsed).toBe(first.nodes.length);

    const second = await indexRepository({ root });
    expect(second.stats.reparsed).toBe(0);
    expect(second.edges).toEqual(first.edges);

    fs.appendFileSync(path.join(root, "src/utils/index.ts"), "\nexport function shout(s: string) { return s.toUpperCase(); }\n");
    const third = await indexRepository({ root });
    expect(third.stats.reparsed).toBe(1);
    expect(node(third, "src/utils/index.ts").symbols.map((s) => s.name)).toEqual(["slugify", "shout"]);

    const cache = fs.readFileSync(path.join(root, ".adam", "cache.json"), "utf8");
    expect(cache).not.toContain("not-a-real-password");
    expect(cache).not.toContain("fixture-not-a-real-key");
  });

  it("can run without writing a cache", async () => {
    await indexRepository({ root, cacheDir: false });
    expect(fs.existsSync(path.join(root, ".adam"))).toBe(false);
  });
});

describe("content access", () => {
  it("masks sensitive nodes but keeps env keys", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const env = readNodeContent(root, node(g, ".env"));
    expect(env.masked).toBe(true);
    expect(env.content).toContain(`DATABASE_URL= ${MASK}`);
    expect(env.content).toContain("# comment stays");
    expect(env.content).not.toContain("not-a-real");
  });

  it("redacts secrets in ordinary files", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const db = readNodeContent(root, node(g, "src/lib/db.ts"));
    expect(db.redactions).toBe(1);
    expect(db.content).toContain(`postgres://admin:${MASK}@localhost`);
    expect(db.content).not.toContain("hunter2");
  });

  it("returns a single symbol's code, dedented", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const code = readSymbolCode(root, node(g, "src/server.ts"), "Server.start");
    expect(code.content).toBe("start(): void {\n  this.app.listen(this.port);\n}");
  });

  it("refuses nodes that point outside the repository", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const evil = { ...node(g, "README.md"), id: "../../etc/passwd" };
    expect(() => readNodeContent(root, evil)).toThrow(/outside/);
  });
});
