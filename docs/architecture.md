# Architecture

Adam is split so the same core can sit behind any client: the VS Code extension today, a
standalone desktop app later.

```
packages/
  core/      UI-agnostic indexer: repo → code graph (nodes, symbols, edges), masking rules
  service/   local HTTP service that owns the index for one repo; serves the API and web UI
  ui/        the network view; runs in a VS Code webview or a browser through one Host interface
  vscode/    the extension: starts the service, shows the UI in a webview, opens files for editing
```

## Flow

1. The extension forks `dist/service.js` for the workspace folder with a random token in its
   environment. The service binds `127.0.0.1` on a free port and reports it back over IPC.
2. The service walks the repo (respecting `.gitignore`), makes every file a node, and parses
   TypeScript and JavaScript with the TypeScript compiler to get symbols, imports and env reads.
   Imports resolve to edges through the nearest `tsconfig.json`/`jsconfig.json`, so path aliases
   and monorepo workspace packages link up. C# files are parsed with tree-sitter (see below);
   `.csproj`, `.sln` and `.slnx` files are read for project references and NuGet packages.
3. Facts per file are cached in `.adam/cache.json`, keyed by size and modified time. A re-index
   only re-reads changed files. The service watches the folder and re-indexes after a save, then
   pushes a `graph` event to clients.
4. The webview asks the extension for data over `postMessage`; the extension forwards to the
   service. In a browser the UI calls the service directly with the token from the URL fragment.

## C# and .NET

C# is parsed with the [tree-sitter C# grammar](https://github.com/tree-sitter/tree-sitter-c-sharp)
running as WebAssembly through `web-tree-sitter`. Two `.wasm` files (about 5.5 MB) ship next to
`service.js`, so the same build works on Windows, macOS and Linux with no .NET SDK, no native
module and no per-platform binary. Roslyn would give exact semantic references, but it needs the
.NET SDK on the engineer's machine (or a self-contained .NET binary per OS), a restore before a
project loads, and seconds of start-up; most of Adam's users will not have it.

Tree-sitter gives syntax only, so edges are resolved by name the way the C# compiler looks names
up, in `packages/core/src/dotnet.ts`:

1. Every C# file contributes the namespaces and fully qualified types it declares, its usings
   (file, `global`, alias, `static`) and the type names it uses.
2. Each `.cs` file belongs to the nearest `.csproj` above it. A name resolves only to files in that
   project or the projects it references (transitively), so two samples that both declare
   `Shop.Models.User` do not cross-link.
3. A name is looked up in the enclosing namespaces (innermost first), then in usings, global
   usings (from `.cs` files and `<Using Include>`), the SDK's implicit usings, aliases and static
   usings.
4. Calls like `builder.AddServices()` link to extension methods of that name declared in a
   namespace the caller can see. Parts of a `partial` type link to each other.

Known gaps: types used only from XAML or Razor, `Directory.Build.props` usings, and calls that
need type inference to tell overloads or same-named extension methods apart. Accuracy against
Roslyn's references is the next benchmark to add.

## Network view

- The view is styled after Graphify's graph page. The layout (`layout.ts`) is nested: each
  colour group gets its own round area, and inside it each subfolder gets its own area, down to
  the files. At every level d3's `packSiblings` packs the entries (subfolders first, then files
  in the order a quick ForceAtlas2 run puts them, so files that import each other sit together)
  with a gap left for labels. The groups are then placed by ForceAtlas2 over the imports between
  them, and noverlap keeps a wide margin between groups. The layout is seeded from file names,
  computed once and never moves. A collapsed folder becomes one node at the centre of its area,
  and edges between nodes are summed file imports. Opening or closing a folder rebuilds the
  screen graph without moving anything.
- Colour groups (`colorGroups` in `model.ts`) start from the clusters. The biggest group keeps
  opening into its subfolders while the groups still fit the 10 colours. A group holding more
  than a quarter of the files opens past that limit (the extra groups are grey). Repos with more
  than 150 files open with each colour group collapsed to one node.
- A node's size grows with its links. Only hubs and folders are labelled; other labels show on
  hover or when the node is lit. Edges are faint curves in their source's colour. The sidebar
  holds search, the inspected node, and the groups with show/hide checkboxes. Labels are
  placed after each frame, most important first, and skip any spot that would cover another
  label or node. An unticked group is always hidden, even inside an open or focused folder.
- Opening a folder frames its files and puts the view in "viewing" mode: the folder's files and
  anything they import or are imported by stay bright, the rest fades. Each open is pushed onto
  a trail shown as a breadcrumb (`All › routes/_app/ › _app/products/`); a crumb, Back or Esc
  returns to that step with the folders that were open then. Esc clears the focus first.
  Clicking the empty canvas only clears the focus, and folders that a focus opened just to show
  a file fold back with it.
- Folders fold along each file's path, starting from its cluster (`apps/web`, `packages/db`).
  Pass-through folders (a parent's only entry, such as `apps/web/src`) and one-file folders are
  skipped, so every expand shows something new.
- Focus is a set of files, not a screen node, so it survives folders opening and closing: the lit
  links are always the focused files' imports, drawn between whatever nodes now hold them.

## Secrets

- Sensitive nodes (`.env*`, keys, certificates, credentials, cloud service accounts, registry
  configs, every `appsettings*.json`, `local.settings.json`, user `secrets.json`,
  `web.config`/`app.config`) never leave the core unmasked. Env-style and settings files show
  their keys only (`DATABASE_URL`, `ConnectionStrings:Default`); a settings file that cannot be
  read cleanly is withheld entirely.
- Secret-looking values in ordinary files (private keys, cloud and VCS tokens, API keys, JWTs,
  connection-string passwords, ADO.NET `Password=`/`AccountKey=` values) are redacted before
  content is served.
- The cache stores no hash and no content for sensitive nodes.
- The service only serves files that are in the index, checks Host and Origin headers, and
  requires the token on every API call.

The same masking path will sit in front of the agent, so a model never sees a secret value.

## What comes next (Phase 1)

- Function panel **Explain**, with bring-your-own model provider settings.
- Agent chat that returns **proposals** (diff, reasoning, affected nodes on the graph), never
  writing until accepted.
- Onboarding report with the access checklist (env vars from `envDeclares` and `envReads`).
- Built-in encrypted secrets vault.
- Summary cache and project memory in `.adam/`.
