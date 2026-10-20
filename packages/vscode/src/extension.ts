import * as vscode from "vscode";
import { NetworkPanel } from "./network-panel";
import { ServiceClient } from "./service-client";

const clients = new Map<string, ServiceClient>();

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Adam");
  const serviceScript = vscode.Uri.joinPath(context.extensionUri, "dist", "service.js").fsPath;

  const clientFor = (folder: vscode.WorkspaceFolder): ServiceClient => {
    const key = folder.uri.toString();
    let client = clients.get(key);
    if (!client) {
      client = new ServiceClient(folder, serviceScript, log);
      clients.set(key, client);
    }
    return client;
  };

  const pickFolder = async (): Promise<vscode.WorkspaceFolder | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage("Open a folder first: Adam maps the code in your workspace.");
      return undefined;
    }
    if (folders.length === 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: "Which folder should Adam map?" });
  };

  const withClient = (action: (client: ServiceClient) => Promise<void>) => async () => {
    const folder = await pickFolder();
    if (!folder) return;
    const client = clientFor(folder);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Adam: starting" },
        () => client.start(),
      );
      await action(client);
    } catch (err) {
      void vscode.window.showErrorMessage(`Adam: ${(err as Error).message}`);
    }
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = "$(type-hierarchy) Adam";
  status.tooltip = "Open the Adam network view";
  status.command = "adam.openNetwork";
  status.show();

  context.subscriptions.push(
    log,
    status,
    vscode.commands.registerCommand(
      "adam.openNetwork",
      withClient(async (client) => NetworkPanel.show(context.extensionUri, client)),
    ),
    vscode.commands.registerCommand(
      "adam.reindex",
      withClient(async (client) => {
        const res = await client.request<{ stats: { nodes: number; edges: number; durationMs: number } }>("POST", "/api/reindex");
        void vscode.window.showInformationMessage(
          `Adam indexed ${res.stats.nodes} nodes and ${res.stats.edges} edges in ${res.stats.durationMs} ms.`,
        );
      }),
    ),
    vscode.commands.registerCommand(
      "adam.openInBrowser",
      withClient(async (client) => {
        await vscode.env.openExternal(vscode.Uri.parse(`${client.url}/#token=${client.token}`));
      }),
    ),
    vscode.commands.registerCommand("adam.showLog", () => log.show()),
    { dispose: () => clients.forEach((c) => c.dispose()) },
  );
}

export function deactivate(): void {
  clients.forEach((c) => c.dispose());
  clients.clear();
}
