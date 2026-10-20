# Adam: Code Network

**See your codebase as a network, not a folder tree.** Adam maps every file in your workspace as a
node and every import as an edge, so you can see how the code connects, where it is coupled and
what is disconnected.

> Preview. This release covers the network view and node panels for TypeScript, JavaScript and
> C#/.NET. Agent proposals, the onboarding report and security overlays are on the way.

## What you get

- **Network view.** Run **Adam: Open Network View** (or click **Adam** in the status bar). Every
  file is a node, whatever its extension. Imports, re-exports, dynamic `import()` and `require`
  calls are edges, resolved through your `tsconfig.json` / `jsconfig.json` paths and across
  monorepo packages. Nodes are coloured by module folder.
- **C# and .NET.** C# files link to the files whose types they use, resolved through namespaces,
  usings and project references, plus extension method calls and partial types. Solutions link to
  their projects and projects to the projects they reference. No .NET SDK needed.
- **Node panel.** Click a node to see its language, size, what it imports, what imports it, the
  packages and environment variables it uses, and imports that do not resolve.
- **Functions collapsed by default.** Every function, class, method and type is listed closed.
  Open one to read just its code, or jump to that line in the editor.
- **Edit by hand any time.** **Open in editor** opens the file in VS Code beside the network.
  The network updates when you save.
- **Folders view.** The classic tree over the same nodes, one click away, in sync with the
  network selection.
- **Secrets stay masked.** `.env` files, `appsettings*.json`, `web.config`, keys and credentials
  are sensitive nodes: Adam shows the variable names and settings keys they declare, never the
  values. Secret-looking values in ordinary code (API keys,
  tokens, connection-string passwords) are masked too.

## Privacy

Adam indexes locally. A small Adam service runs on your machine, listens on `127.0.0.1` only and
requires a per-session token. Nothing is uploaded. An incremental cache is written to `.adam/` in
your workspace so re-opening a large repo is fast; it never contains secret values.

## Settings

| Setting | What it does |
| --- | --- |
| `adam.ignore` | Extra paths to leave out of the network, in `.gitignore` syntax. `node_modules`, build output and everything in `.gitignore` are already left out. |

## Commands

- **Adam: Open Network View**
- **Adam: Re-index Workspace**
- **Adam: Open Network View in Browser**: the same view in your browser, served by the local service.
- **Adam: Show Log**
