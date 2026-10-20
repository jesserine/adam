import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import {
  indexRepository,
  probeAiProviderKey,
  readNodeContent,
  readSymbolCode,
  type AiProvider,
  type AiValidationResult,
  type CodeGraph,
  type DeleteAiConfigRequest,
  type IndexOptions,
  type SaveAiConfigRequest,
  type ValidateAiKeyRequest,
} from "@adam/core";
import { AiConfigStore } from "./ai-store";

export interface ServiceOptions extends IndexOptions {
  /** Shared secret every API call must present. Generated when omitted. */
  token?: string;
  /** Folder holding the built web UI (index.html, main.js, main.css). Omit to serve the API only. */
  uiDir?: string;
  /** Re-index when files change. Default true. */
  watch?: boolean;
  /** Called after every index run, e.g. for logging. */
  onIndexed?: (graph: CodeGraph) => void;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};
const WATCH_SKIP = /(^|[\\/])(\.git|\.adam|node_modules|dist|build|out|\.next|coverage)([\\/]|$)/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The local Adam service: owns the index for one repository and serves it to any client
 * (the VS Code extension, the standalone web UI, later a desktop app) over localhost.
 *
 * It listens on 127.0.0.1 only, requires a bearer token on every API call, and rejects
 * foreign Host and Origin headers so web pages in the user's browser cannot read the graph.
 */
export class AdamService {
  readonly token: string;
  readonly aiStore: AiConfigStore;
  private graph: CodeGraph | undefined;
  private indexing: Promise<CodeGraph> | undefined;
  private pending = false;
  private server: http.Server | undefined;
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private readonly clients = new Set<http.ServerResponse>();
  private port = 0;

  constructor(private readonly options: ServiceOptions) {
    this.token = options.token ?? randomBytes(24).toString("base64url");
    const configDir = typeof options.cacheDir === "string" ? options.cacheDir : path.join(this.root, ".adam");
    this.aiStore = new AiConfigStore(path.join(configDir, "ai-config.json"));
  }

  get root(): string {
    return path.resolve(this.options.root);
  }

  /** Starts listening and kicks off the first index. Resolves to the bound port. */
  async start(port = 0): Promise<number> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendJson(res, status, { error: message });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    // Clients asking for the graph wait for this first run, so the port is usable right away.
    void this.reindex().catch(() => undefined);
    if (this.options.watch !== false) this.startWatching();
    return this.port;
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    clearTimeout(this.debounce);
    for (const res of this.clients) res.end();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Re-indexes the repository. Concurrent calls share one run, plus at most one follow-up. */
  async reindex(): Promise<CodeGraph> {
    if (this.indexing) {
      this.pending = true;
      return this.indexing;
    }
    this.indexing = (async () => {
      try {
        let graph: CodeGraph;
        do {
          this.pending = false;
          graph = await indexRepository(this.options);
        } while (this.pending);
        this.graph = graph;
        this.options.onIndexed?.(graph);
        this.broadcast("graph", { generatedAt: graph.generatedAt, stats: graph.stats });
        return graph;
      } finally {
        this.indexing = undefined;
      }
    })();
    return this.indexing;
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, file) => {
        if (file && WATCH_SKIP.test(file.toString())) return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.reindex().catch(() => undefined), 300);
      });
      this.watcher.on("error", () => undefined);
    } catch {
      // Recursive watch is unavailable on some platforms; the client can still ask for a reindex.
    }
  }

  private async currentGraph(): Promise<CodeGraph> {
    return this.graph ?? (await this.reindex());
  }

  private checkOrigin(req: http.IncomingMessage): void {
    const host = req.headers.host ?? "";
    const hostname = host.replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(hostname)) throw new HttpError(403, "Forbidden host");
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw new HttpError(403, "Forbidden origin");
  }

  private checkToken(req: http.IncomingMessage, url: URL): void {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("token") ?? "");
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "Missing or invalid token");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.checkOrigin(req);
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (!url.pathname.startsWith("/api/")) return this.serveStatic(url.pathname, res);

    this.checkToken(req, url);
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/health":
        return sendJson(res, 200, { ok: true, root: this.root, port: this.port });
      case "GET /api/graph":
        return sendJson(res, 200, await this.currentGraph());
      case "POST /api/reindex": {
        const graph = await this.reindex();
        return sendJson(res, 200, { generatedAt: graph.generatedAt, stats: graph.stats });
      }
      case "GET /api/node": {
        const node = await this.findNode(url.searchParams.get("id"));
        return sendJson(res, 200, { node, ...readNodeContent(this.root, node) });
      }
      case "GET /api/symbol": {
        const node = await this.findNode(url.searchParams.get("node"));
        const symbolId = url.searchParams.get("id");
        if (!symbolId || !node.symbols.some((s) => s.id === symbolId)) throw new HttpError(404, "Unknown symbol");
        return sendJson(res, 200, readSymbolCode(this.root, node, symbolId));
      }
      case "GET /api/events":
        return this.openEvents(res);
      case "GET /api/ai/config":
        return sendJson(res, 200, await this.aiStore.getConfigSummary());
      case "POST /api/ai/config": {
        const body = await readJsonBody<SaveAiConfigRequest>(req);
        if (!body.provider) throw new HttpError(400, "Missing provider");
        const summary = await this.aiStore.saveKey(body);
        return sendJson(res, 200, summary);
      }
      case "DELETE /api/ai/config": {
        const body = await readJsonBody<DeleteAiConfigRequest>(req);
        if (!body.provider) throw new HttpError(400, "Missing provider");
        const summary = await this.aiStore.deleteKey(body.provider);
        return sendJson(res, 200, summary);
      }
      case "POST /api/ai/active": {
        const body = await readJsonBody<{ provider: AiProvider }>(req);
        if (!body.provider) throw new HttpError(400, "Missing provider");
        const summary = await this.aiStore.setActiveProvider(body.provider);
        return sendJson(res, 200, summary);
      }
      case "POST /api/ai/validate": {
        const body = await readJsonBody<ValidateAiKeyRequest>(req);
        if (!body.provider) throw new HttpError(400, "Missing provider");
        const key = body.apiKey || (await this.aiStore.getRawKey(body.provider));
        if (!key) {
          const result: AiValidationResult = {
            provider: body.provider,
            ok: false,
            message: "No API key configured for provider",
          };
          return sendJson(res, 200, result);
        }
        const result = await probeAiProviderKey(body.provider, key);
        await this.aiStore.recordTestResult(body.provider, result.ok, result.ok ? undefined : result.message);
        return sendJson(res, 200, result);
      }
      default:
        throw new HttpError(404, "Not found");
    }
  }

  /** Looks a node up in the index. Only indexed ids are served, never arbitrary paths. */
  private async findNode(id: string | null) {
    const graph = await this.currentGraph();
    const node = id ? graph.nodes.find((n) => n.id === id) : undefined;
    if (!node) throw new HttpError(404, "Unknown node");
    return node;
  }

  private openEvents(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(payload);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const uiDir = this.options.uiDir;
    if (!uiDir) throw new HttpError(404, "Not found");
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const abs = path.resolve(uiDir, rel);
    if (path.relative(uiDir, abs).startsWith("..") || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new HttpError(404, "Not found");
    }
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[path.extname(abs)] ?? "application/octet-stream",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    fs.createReadStream(abs).pipe(res);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        req.destroy();
        reject(new HttpError(413, "Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
