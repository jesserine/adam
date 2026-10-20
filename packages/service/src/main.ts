#!/usr/bin/env node
import * as path from "node:path";
import { parseArgs } from "node:util";
import { AdamService } from "./server";

/**
 * Runs the Adam service for one repository.
 *
 *   adam-service --root ./my-app [--port 4870] [--no-watch] [--ignore <pattern>]...
 *
 * The token comes from ADAM_TOKEN (so it never shows in a process list) or is generated.
 * When started by the VS Code extension over IPC, it reports `{ type: "ready", port }`.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: process.cwd() },
      port: { type: "string" },
      "no-watch": { type: "boolean", default: false },
      "no-ui": { type: "boolean", default: false },
      ignore: { type: "string", multiple: true, default: [] },
    },
  });

  const service = new AdamService({
    root: path.resolve(values.root!),
    token: process.env.ADAM_TOKEN || undefined,
    watch: !values["no-watch"],
    ignore: values.ignore,
    uiDir: values["no-ui"] ? undefined : path.join(__dirname, "ui"),
    onIndexed: (g) =>
      log(`indexed ${g.stats.nodes} nodes, ${g.stats.edges} edges (${g.stats.reparsed} re-read) in ${g.stats.durationMs} ms`),
  });

  const requested = values.port ?? (process.send ? "0" : "4870");
  const port = await service.start(Number(requested));

  if (process.send) {
    process.send({ type: "ready", port });
    process.on("disconnect", () => void service.stop().then(() => process.exit(0)));
  } else {
    log(`serving ${service.root}`);
    log(`open http://127.0.0.1:${port}/#token=${service.token}`);
  }

  const shutdown = () => void service.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function log(message: string): void {
  process.stderr.write(`[adam] ${message}\n`);
}

main().catch((err: unknown) => {
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
