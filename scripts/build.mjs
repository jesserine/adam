// Builds every shippable piece with esbuild:
//   packages/service/dist/  standalone service (main.js) + C# parser (.wasm) + web UI (ui/)
//   packages/vscode/dist/   extension.js + service.js + C# parser (.wasm) + ui/  (what goes into the .vsix)
// Pass --dev for unminified output with source maps.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
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

// The C# parser runs as WebAssembly; the service loads these from its own folder.
const require = createRequire(join(root, "packages/core/package.json"));
const WASM = [require.resolve("web-tree-sitter/tree-sitter.wasm"), require.resolve("tree-sitter-c-sharp/tree-sitter-c_sharp.wasm")];

// web-tree-sitter's ESM build finds itself through import.meta.url, which a CommonJS bundle lacks;
// its CommonJS build works in both.
const nodeAliases = { "web-tree-sitter": require.resolve("web-tree-sitter") };

async function buildService(outfile) {
  for (const wasm of WASM) {
    mkdirSync(dirname(outfile), { recursive: true });
    copyFileSync(wasm, join(dirname(outfile), wasm.split(/[\\/]/).pop()));
  }
  await build({
    ...common,
    entryPoints: [p("packages/service/src/main.ts")],
    outfile,
    format: "cjs",
    platform: "node",
    target: "node20",
    alias: nodeAliases,
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
