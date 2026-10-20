import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiConfigSummary, AiValidationResult, CodeGraph } from "@adam/core";
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

  it("manages AI provider configuration securely", async () => {
    // 1. Initial config should have no configured providers
    const getRes = await api("/api/ai/config");
    expect(getRes.status).toBe(200);
    const initialSummary = (await getRes.json()) as AiConfigSummary;
    expect(initialSummary.activeProvider).toBeUndefined();
    expect(initialSummary.providers.chatgpt.configured).toBe(false);
    expect(initialSummary.providers.claude.configured).toBe(false);
    expect(initialSummary.providers.grok.configured).toBe(false);
    expect(initialSummary.providers.gemini.configured).toBe(false);

    // 2. Save a key for claude
    const saveRes = await api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        apiKey: "sk-ant-api03-abcdefghijklmn1234",
        selectedModel: "claude-3-7-sonnet-20250219",
      }),
    });
    expect(saveRes.status).toBe(200);
    const savedSummary = (await saveRes.json()) as AiConfigSummary;
    expect(savedSummary.activeProvider).toBe("claude");
    expect(savedSummary.providers.claude.configured).toBe(true);
    expect(savedSummary.providers.claude.maskedKey).toBe("sk-ant-...1234");
    // Ensure raw key was never returned
    expect(JSON.stringify(savedSummary)).not.toContain("abcdefghijklmn");

    // 3. Save a second key (chatgpt) without setting active
    await api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "chatgpt",
        apiKey: "sk-proj-openai9876543210zyxwvu",
      }),
    });

    // 4. Set chatgpt as active provider
    const activeRes = await api("/api/ai/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt" }),
    });
    const activeSummary = (await activeRes.json()) as AiConfigSummary;
    expect(activeSummary.activeProvider).toBe("chatgpt");

    // 5. Delete active provider
    const deleteRes = await api("/api/ai/config", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt" }),
    });
    const deleteSummary = (await deleteRes.json()) as AiConfigSummary;
    expect(deleteSummary.activeProvider).toBeUndefined();
    expect(deleteSummary.providers.chatgpt.configured).toBe(false);
    expect(deleteSummary.providers.chatgpt.maskedKey).toBeUndefined();
    // Claude should still be configured
    expect(deleteSummary.providers.claude.configured).toBe(true);

    // 6. Test validation endpoint
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("anthropic.com")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        } as unknown as Response);
      }
      return originalFetch(url, init);
    });

    try {
      // Validate stored claude key
      const valRes = await api("/api/ai/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "claude" }),
      });
      expect(valRes.status).toBe(200);
      const valBody = (await valRes.json()) as AiValidationResult;
      expect(valBody.ok).toBe(true);
      expect(valBody.provider).toBe("claude");

      // Validate provider with no key stored
      const noKeyRes = await api("/api/ai/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      });
      const noKeyBody = (await noKeyRes.json()) as AiValidationResult;
      expect(noKeyBody.ok).toBe(false);
      expect(noKeyBody.message).toContain("No API key");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
