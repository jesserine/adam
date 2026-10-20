# Testing Adam locally

Three ways to try Adam on your own machine, from quickest to closest to what users get.

## Before you start

- **Node.js 22.12 or newer.** Check with `node -v`. Get it from <https://nodejs.org> (LTS).
- **Git** and **VS Code 1.90 or newer**.
- A TypeScript or JavaScript project to look at. Any of your own repos works.

```sh
git clone https://github.com/jueviolegrace13/adam.git
cd adam
npm install
npm run check    # typecheck, tests and bundles; should end with "Built release bundles."
```

## Option 1: in the browser (no VS Code needed)

```sh
node packages/service/dist/main.js --root /path/to/your/project
```

It prints a line like `open http://127.0.0.1:4870/#token=...`. Open that exact URL (the token is
part of it). Stop the service with Ctrl+C.

On Windows use a Windows path, for example `--root C:\Users\you\code\my-app`.

## Option 2: debug the extension with F5

1. Open the `adam` folder in VS Code.
2. Press **F5** (or Run and Debug → **Run Adam extension**). It builds the extension and opens a
   second VS Code window, the *Extension Development Host*, with a small sample app.
3. In that window, click **Adam** in the status bar, or run **Adam: Open Network View** from the
   command palette (Ctrl+Shift+P / Cmd+Shift+P).
4. To try your own project, use **File → Open Folder** in that same window, then open the network
   view again.

Logs from the extension and its local service are under **Adam: Show Log**.

## Option 3: install the packaged extension

This is exactly what a Marketplace user would install.

```sh
npm run package   # writes packages/vscode/adam-0.1.0.vsix
```

Then in VS Code: Extensions view → **⋯** menu → **Install from VSIX…** → pick the file. Or, if
the `code` command is on your PATH:

```sh
code --install-extension packages/vscode/adam-0.1.0.vsix
```

Open any project folder and run **Adam: Open Network View**. To remove it later, uninstall
"Adam: Code Network" from the Extensions view.

## What to check

- **Network:** every file is a dot, imports are faint curved lines, and colours are groups of
  folders. A node's size follows how many links it has, and only the busiest files are
  labelled. Scroll to zoom, drag to pan, and use **Fit** to frame what is on screen.
- **Sidebar:** search at the top, then the inspected node, then **Groups**. Each group shows its
  colour and file count; untick a group to hide it, or untick **Show all** to hide them all.
- **Clusters:** a repo with more than 150 files opens collapsed, with one node per colour group
  (`excalidraw/components/ · 309`) and lines summed between them. Double-click a folder, or
  **Expand folder** in its panel, to open it into its subfolders and files. **Collapse folder** on
  any node inside folds it back. **Expand all** and **Collapse all** are in the toolbar.
- **Viewing a folder:** opening a folder zooms to its files and fades everything it does not
  connect to. The bar at the top shows the path you took (`All › routes/_app/ › _app/products/`):
  click a crumb, **Back** or Esc to return to that step. Unticking a group hides its nodes even
  while you are inside one of its folders.
- **Spacing:** every group sits in its own area with its name above it, every subfolder in its
  own clump inside, and labels never cover another node.
- **Hover a node:** its links light up and the rest fades, until the pointer leaves.
- **Click a node (focus):** its links stay lit and a bar at the top says what is focused. Bright
  arrows are imports, grey ones are imported-by. While focused, clicking any other node only
  opens its panel (its link to the focus is drawn thicker); the lit links do not change. Click the
  empty canvas, press Esc or **Clear focus** to unfocus; folders the focus opened fold back.
- **Panel:** for a file, language, size, imports, imported-by, packages and env variables it
  reads. For a folder, its size, the folders it imports from and is imported by (with counts),
  and its files.
- **Symbols:** functions, classes, methods and types are listed collapsed. Open one to see only
  its code; **Open at line** jumps to it in the editor.
- **Manual editing:** **Open in editor** opens the file beside the network. Save a change (for
  example add an import) and the network updates within a second.
- **Secrets:** click a `.env` file. You should see variable names with `••••••••` instead of
  values. Opening it in the editor asks first.
- **Folders:** the **Folders** tab shows the usual tree over the same nodes.
- **Filters and search:** "Hide unconnected", "Hide type-only imports", and the search box
  (file name, path or function name, then Enter).

Adam writes a cache to `.adam/` in the project you open. It is safe to delete, and you can add
`.adam/` to that project's `.gitignore` if you don't want to commit it.

## If something goes wrong

- **"The Adam service did not start in time"**: run **Adam: Show Log** and look at the last lines.
- **Blank network**: the folder may have no files Adam reads, or everything is in `.gitignore`.
- **`npm install` fails**: check `node -v` is 22.12 or newer.
