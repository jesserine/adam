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
   and monorepo workspace packages link up.
3. Facts per file are cached in `.adam/cache.json`, keyed by size and modified time. A re-index
   only re-reads changed files. The service watches the folder and re-indexes after a save, then
   pushes a `graph` event to clients.
4. The webview asks the extension for data over `postMessage`; the extension forwards to the
   service. In a browser the UI calls the service directly with the token from the URL fragment.

## Network view

- One ForceAtlas2 layout runs over every file. What is on screen is built from it: a folder that
  is collapsed becomes one node at the middle of its files, and edges between nodes are summed
  file imports. Opening or closing a folder rebuilds the screen graph without moving the layout,
  and the camera keeps a fixed frame, so nothing else jumps.
- Folders fold along each file's path, starting from its cluster (`apps/web`, `packages/db`).
  Pass-through folders (a parent's only entry, such as `apps/web/src`) and one-file folders are
  skipped, so every expand shows something new.
- Focus is a set of files, not a screen node, so it survives folders opening and closing: the lit
  links are always the focused files' imports, drawn between whatever nodes now hold them.

## Secrets

- Sensitive nodes (`.env*`, keys, certificates, credentials, cloud service accounts, registry
  configs, non-development `appsettings`) never leave the core unmasked. Env-style files show
  their variable names only.
- Secret-looking values in ordinary files (private keys, cloud and VCS tokens, API keys, JWTs,
  connection-string passwords) are redacted before content is served.
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
