// Builds every shippable piece with esbuild:
//   packages/service/dist/  standalone service (main.js) + web UI (ui/)
//   packages/vscode/dist/   extension.js + service.js + ui/  (what goes into the .vsix)
// Pass --dev for unminified output with source maps.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const p = (...parts) => join(root, ...parts);

const common = { bundle: true, minify: !dev, sourcemap: dev, logLevel: "warning", legalComments: "none" };

async function buildUi(outdir) {
  await build({
    ...common,
    entryPoints: { main: p("packages/ui/src/main.ts") },
    outdir,
    format: "iife",
    platform: "browser",
    target: "es2022",
  });
  copyFileSync(p("packages/ui/index.html"), join(outdir, "index.html"));
}

async function buildService(outfile) {
  await build({
    ...common,
    entryPoints: [p("packages/service/src/main.ts")],
    outfile,
    format: "cjs",
    platform: "node",
    target: "node20",
  });
}

for (const dir of ["packages/service/dist", "packages/vscode/dist"]) rmSync(p(dir), { recursive: true, force: true });
mkdirSync(p("packages/vscode/dist"), { recursive: true });

await Promise.all([
  buildUi(p("packages/service/dist/ui")),
  buildService(p("packages/service/dist/main.js")),
  buildUi(p("packages/vscode/dist/ui")),
  buildService(p("packages/vscode/dist/service.js")),
  build({
    ...common,
    entryPoints: [p("packages/vscode/src/extension.ts")],
    outfile: p("packages/vscode/dist/extension.js"),
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["vscode"],
  }),
]);

// The marketplace listing shows the extension's own README and licence.
copyFileSync(p("LICENSE.md"), p("packages/vscode/LICENSE.md"));

console.log(`Built ${dev ? "dev" : "release"} bundles.`);
