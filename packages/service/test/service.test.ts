import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeGraph } from "@adam/core";
import { AdamService } from "../src";

const FIXTURE = path.join(__dirname, "..", "..", "core", "test", "fixtures", "sample-app");

let root: string;
let uiDir: string;
let service: AdamService;
let base: string;

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, { ...init, headers: { Authorization: `Bearer ${service.token}`, ...init.headers } });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "adam-svc-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "adam-ui-"));
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>Adam</title>");
  service = new AdamService({ root, uiDir, watch: false, cacheDir: false });
  const port = await service.start(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(uiDir, { recursive: true, force: true });
});

describe("AdamService", () => {
  it("rejects API calls without the token", async () => {
    expect((await fetch(`${base}/api/graph`)).status).toBe(401);
    expect((await fetch(`${base}/api/graph`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("rejects foreign origins even with the token", async () => {
    const res = await api("/api/graph", { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("serves the graph", async () => {
    const res = await api("/api/graph");
    expect(res.status).toBe(200);
    const graph = (await res.json()) as CodeGraph;
    expect(graph.nodes.some((n) => n.id === "src/server.ts")).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(5);
  });

  it("serves node content with secrets masked", async () => {
    const env = await (await api("/api/node?id=.env")).json();
    expect(env.masked).toBe(true);
    expect(JSON.stringify(env)).not.toContain("not-a-real");

    const db = await (await api(`/api/node?id=${encodeURIComponent("src/lib/db.ts")}`)).json();
    expect(db.content).not.toContain("hunter2");
    expect(db.node.symbols[0].name).toBe("connect");
  });

  it("serves one symbol's code", async () => {
    const res = await api(`/api/symbol?node=${encodeURIComponent("src/server.ts")}&id=createServer`);
    const body = await res.json();
    expect(body.content).toContain("return new Server(db);");
    expect(body.symbol.kind).toBe("function");
  });

  it("only serves indexed nodes", async () => {
    expect((await api("/api/node?id=../../etc/passwd")).status).toBe(404);
    expect((await api("/api/node?id=ignored/hidden.ts")).status).toBe(404);
    expect((await api(`/api/symbol?node=src/server.ts&id=nope`)).status).toBe(404);
  });

  it("re-indexes on request and announces it to event listeners", async () => {
    const controller = new AbortController();
    const events = await fetch(`${base}/api/events?token=${service.token}`, { signal: controller.signal });
    const reader = events.body!.getReader();
    await reader.read(); // ": connected"

    fs.writeFileSync(path.join(root, "src/new.ts"), 'import { slugify } from "./utils";\nexport const x = slugify("A");\n');
    const stats = await (await api("/api/reindex", { method: "POST" })).json();
    expect(stats.stats.nodes).toBe(16);

    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: graph");
    controller.abort();
  });

  it("serves the UI without a token, and nothing outside it", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });
});
