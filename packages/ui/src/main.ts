import type { AiConfigSummary, CodeGraph } from "@adam/core";
import { getAiButtonInfo, openAiSettingsDialog } from "./ai-settings";
import { h } from "./dom";
import { createHost } from "./host";
import { adjacency, buildTree, isGroupId, type TreeEntry } from "./model";
import { NetworkView, type NetworkState, type Theme } from "./network";
import { renderGroupPanel, renderNodePanel } from "./panel";
import "./styles.css";

const host = createHost();

function detectTheme(): Theme {
  const cls = document.body.classList;
  if (cls.contains("vscode-light") || cls.contains("vscode-high-contrast-light")) return "light";
  if (cls.contains("vscode-dark") || cls.contains("vscode-high-contrast")) return "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const state = {
  graph: undefined as CodeGraph | undefined,
  adj: undefined as ReturnType<typeof adjacency> | undefined,
  focus: undefined as string | undefined,
  /** The node or folder whose panel is open. */
  selected: undefined as string | undefined,
  view: "network" as "network" | "folders",
};

// Layout -------------------------------------------------------------------------------------

const search = h("input", { type: "search", placeholder: "Find a node…", list: "adam-nodes", "aria-label": "Find a node" });
const datalist = h("datalist", { id: "adam-nodes" });
const stats = h("span", { class: "stats" }, "Indexing…");
const networkTab = h("button", { class: "tab active", onclick: () => setView("network") }, "Network");
const foldersTab = h("button", { class: "tab", onclick: () => setView("folders") }, "Folders");
const hideUnconnected = h("input", { type: "checkbox", id: "f-unconnected" });
const hideTypeOnly = h("input", { type: "checkbox", id: "f-typeonly" });
const legend = h("div", { class: "legend", "aria-label": "Legend" });
const networkEl = h("div", { class: "network" });
const treeEl = h("div", { class: "tree", hidden: true });
const panelEl = h("aside", { class: "panel", hidden: true });
const statusEl = h("div", { class: "status", hidden: true });
const focusBar = h("div", { class: "focus-bar", hidden: true });

const aiButton = h(
  "button",
  {
    class: "ghost ai-settings-btn",
    title: "Configure AI providers & API keys",
    onclick: () => void openAiSettingsDialog(host, (summary) => void updateAiButton(summary)),
  },
  "✨ Configure AI",
);

async function updateAiButton(summary?: AiConfigSummary): Promise<void> {
  try {
    const config = summary ?? (await host.getAiConfig());
    const info = getAiButtonInfo(config);
    aiButton.replaceChildren();
    if (info.isActive) {
      aiButton.append(h("span", { class: "ai-active-dot", "aria-hidden": "true" }), info.label);
    } else {
      aiButton.textContent = info.label;
    }
  } catch {
    aiButton.textContent = "✨ Configure AI";
  }
}

document.body.append(
  h(
    "div",
    { class: "app" },
    h(
      "header",
      { class: "toolbar" },
      h("span", { class: "brand" }, "Adam"),
      h("div", { class: "tabs", role: "tablist" }, networkTab, foldersTab),
      search,
      datalist,
      h("label", { class: "filter" }, hideUnconnected, "Hide unconnected"),
      h("label", { class: "filter" }, hideTypeOnly, "Hide type-only imports"),
      h("button", { class: "ghost", onclick: () => void reindex(), title: "Re-index the repository" }, "Re-index"),
      h("button", { class: "ghost", onclick: () => network.expandAll(), title: "Show every file" }, "Expand all"),
      h("button", { class: "ghost", onclick: () => network.collapseAll(), title: "Fold every folder back into its cluster" }, "Collapse all"),
      h("button", { class: "ghost", onclick: () => network.fit(), title: "Fit what is on screen" }, "Fit"),
      aiButton,
      stats,
    ),
    h("main", { class: "main" }, h("div", { class: "canvas" }, networkEl, treeEl, focusBar, legend, statusEl), panelEl),
  ),
);

const network = new NetworkView(networkEl, detectTheme(), (s) => onNetworkChange(s));

new MutationObserver(() => {
  network.setTheme(detectTheme());
  renderLegend();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

const applyFilters = () => network.setFilters({ hideUnconnected: hideUnconnected.checked, hideTypeOnly: hideTypeOnly.checked });
hideUnconnected.addEventListener("change", applyFilters);
hideTypeOnly.addEventListener("change", applyFilters);

search.addEventListener("change", () => findNode(search.value));
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") findNode(search.value);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) network.clearFocus();
});

// Behaviour ----------------------------------------------------------------------------------

function findNode(query: string): void {
  const q = query.trim().toLowerCase();
  if (!q || !state.graph) return;
  const hit =
    state.graph.nodes.find((n) => n.id.toLowerCase() === q) ??
    state.graph.nodes.find((n) => n.name.toLowerCase() === q) ??
    state.graph.nodes.find((n) => n.id.toLowerCase().includes(q)) ??
    state.graph.nodes.find((n) => n.symbols.some((s) => s.name.toLowerCase() === q));
  if (!hit) {
    showStatus(`No node matches “${query}”.`);
    return;
  }
  network.focusOn(hit.id);
}

/** Clicking a node, a link in the panel or a file in the tree all go through the network's focus rules. */
function select(id: string): void {
  network.activate(id);
}

function onNetworkChange(next: NetworkState): void {
  const changed = next.inspected !== state.selected || next.focus !== state.focus;
  state.focus = next.focus;
  state.selected = next.inspected;
  renderFocusBar();
  if (changed) renderPanel();
  markTreeSelection();
}

function renderFocusBar(): void {
  focusBar.hidden = !state.focus || state.view !== "network";
  if (!state.focus) return;
  focusBar.replaceChildren(
    h("span", {}, "Focused on ", h("strong", {}, network.labelOf(state.focus))),
    h("span", { class: "hint" }, h("i", { class: "arrow-out" }), "imports"),
    h("span", { class: "hint" }, h("i", { class: "arrow-in" }), "imported by"),
    h("span", { class: "hint" }, "Clicking a node opens its panel and keeps these links."),
    h("button", { class: "ghost", onclick: () => network.clearFocus(), title: "Clear focus (Esc)" }, "Clear focus"),
  );
}

function setView(view: "network" | "folders"): void {
  state.view = view;
  networkTab.classList.toggle("active", view === "network");
  foldersTab.classList.toggle("active", view === "folders");
  networkEl.hidden = view !== "network";
  legend.hidden = view !== "network";
  treeEl.hidden = view !== "folders";
  if (view === "folders") renderTree();
  renderFocusBar();
}

function renderPanel(): void {
  const id = state.selected;
  if (!id || !state.graph || !state.adj) {
    panelEl.hidden = true;
    return;
  }
  const collapse = network.canCollapse(id)
    ? [h("button", { class: "ghost", onclick: () => network.toggle(id), title: "Fold this back into its folder" }, "Collapse folder")]
    : [];
  if (isGroupId(id)) {
    const info = network.groupInfo(id);
    const files = new Set(info.files);
    renderGroupPanel(panelEl, {
      folder: info.folder,
      files: state.graph.nodes.filter((n) => files.has(n.id)),
      ...network.links(id),
      onExpand: () => network.toggle(id),
      onSelect: select,
      actions: collapse,
    });
  } else {
    const node = state.graph.nodes.find((n) => n.id === id);
    if (!node) {
      panelEl.hidden = true;
      return;
    }
    renderNodePanel(panelEl, node, {
      host,
      incoming: state.adj.incoming.get(node.id) ?? [],
      outgoing: state.adj.outgoing.get(node.id) ?? [],
      onSelect: select,
      actions: collapse,
    });
  }
  panelEl.hidden = false;
  panelEl.scrollTop = 0;
}

function renderTree(): void {
  if (!state.graph) return;
  const render = (entries: TreeEntry[], depth: number): HTMLElement => {
    const ul = h("ul", { role: depth === 0 ? "tree" : "group" });
    for (const e of entries) {
      if (e.children) {
        const det = h("details", { open: depth === 0 }, h("summary", {}, `${e.name}/`), render(e.children, depth + 1));
        ul.append(h("li", {}, det));
      } else {
        ul.append(h("li", {}, h("button", { class: "tree-file", "data-id": e.path, onclick: () => select(e.path) }, e.name)));
      }
    }
    return ul;
  };
  treeEl.replaceChildren(render(buildTree(state.graph.nodes), 0));
  markTreeSelection();
}

function markTreeSelection(): void {
  treeEl.querySelectorAll<HTMLButtonElement>(".tree-file").forEach((b) => {
    const on = b.dataset.id === state.selected;
    b.classList.toggle("selected", on);
    if (on) {
      for (let p = b.parentElement; p && p !== treeEl; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
    }
  });
}

function renderLegend(): void {
  legend.replaceChildren(
    ...network.legend().map((i) => h("span", { class: "legend-item" }, h("i", { style: `background:${i.color}` }), i.label)),
  );
}

function showStatus(message: string | undefined): void {
  statusEl.hidden = !message;
  statusEl.textContent = message ?? "";
}

async function load(): Promise<void> {
  try {
    const graph = await host.getGraph();
    state.graph = graph;
    state.adj = adjacency(graph);
    network.load(graph);
    datalist.replaceChildren(...graph.nodes.map((n) => h("option", { value: n.id })));
    const s = graph.stats;
    stats.textContent = `${s.nodes} nodes · ${s.edges} edges · ${s.sensitive} sensitive`;
    stats.title = `Indexed in ${s.durationMs} ms (${s.reparsed} files re-read)`;
    renderLegend();
    if (state.view === "folders") renderTree();
    renderPanel();
    showStatus(graph.nodes.length ? undefined : "This folder has no files to index.");
  } catch (err) {
    showStatus(`Could not load the graph: ${(err as Error).message}`);
  }
}

async function reindex(): Promise<void> {
  stats.textContent = "Re-indexing…";
  try {
    await host.reindex();
  } catch (err) {
    showStatus(`Re-index failed: ${(err as Error).message}`);
  }
  await load();
}

host.onGraphChanged(() => void load());
void load();
void updateAiButton();
