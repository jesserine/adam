import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";

const READY_TIMEOUT_MS = 20_000;

/**
 * Runs one Adam service per workspace folder as a child process and talks to it over
 * localhost with a per-session token. The service holds the index; the extension is only a client.
 */
export class ServiceClient implements vscode.Disposable {
  readonly token = randomBytes(24).toString("base64url");
  private child: ChildProcess | undefined;
  private port = 0;
  private ready: Promise<void> | undefined;
  private events: http.ClientRequest | undefined;
  private readonly graphChanged = new vscode.EventEmitter<void>();
  readonly onGraphChanged = this.graphChanged.event;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly serviceScript: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Starts the service if it is not running yet. */
  start(): Promise<void> {
    this.ready ??= this.spawn().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  async request<T>(method: "GET" | "POST", path: string): Promise<T> {
    await this.start();
    const res = await fetch(`${this.url}${path}`, { method, headers: { Authorization: `Bearer ${this.token}` } });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body;
  }

  dispose(): void {
    this.events?.destroy();
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
    this.graphChanged.dispose();
  }

  private spawn(): Promise<void> {
    const ignore = vscode.workspace.getConfiguration("adam", this.folder.uri).get<string[]>("ignore", []);
    const args = ["--root", this.folder.uri.fsPath, "--port", "0", ...ignore.flatMap((p) => ["--ignore", p])];
    this.log.appendLine(`Starting Adam service for ${this.folder.uri.fsPath}`);

    const child = fork(this.serviceScript, args, {
      // The token travels in the environment, not argv, so it does not show in process lists.
      env: { ...process.env, ADAM_TOKEN: this.token, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.log.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.log.append(d.toString()));

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The Adam service did not start in time. See the Adam output.")), READY_TIMEOUT_MS);
      child.on("message", (msg: { type?: string; port?: number }) => {
        if (msg.type !== "ready" || !msg.port) return;
        clearTimeout(timer);
        this.port = msg.port;
        this.listen();
        resolve();
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        this.log.appendLine(`Adam service exited (${code ?? "signal"})`);
        if (this.child === child) {
          this.child = undefined;
          this.ready = undefined;
        }
        reject(new Error(`The Adam service exited with code ${code}. See the Adam output.`));
      });
    });
  }

  /** Follows the service's event stream and re-emits graph updates. */
  private listen(): void {
    this.events = http.get(`${this.url}/api/events?token=${encodeURIComponent(this.token)}`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (chunk.includes("event: graph")) this.graphChanged.fire();
      });
    });
    this.events.on("error", () => undefined);
  }
}
