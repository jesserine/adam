import type { CodeGraph } from "@adam/core";
import { h } from "./dom";
import { createHost } from "./host";
import { adjacency, buildTree, type TreeEntry } from "./model";
import { NetworkView, type Theme } from "./network";
import { renderNodePanel } from "./panel";
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
      h("button", { class: "ghost", onclick: () => network.resetCamera(), title: "Fit the whole network" }, "Fit"),
      stats,
    ),
    h("main", { class: "main" }, h("div", { class: "canvas" }, networkEl, treeEl, legend, statusEl), panelEl),
  ),
);

const network = new NetworkView(networkEl, detectTheme(), (id) => select(id));

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
  select(hit.id);
  network.focus(hit.id);
}

function select(id: string | undefined): void {
  state.selected = id;
  network.select(id);
  renderPanel();
  markTreeSelection();
}

function setView(view: "network" | "folders"): void {
  state.view = view;
  networkTab.classList.toggle("active", view === "network");
  foldersTab.classList.toggle("active", view === "folders");
  networkEl.hidden = view !== "network";
  legend.hidden = view !== "network";
  treeEl.hidden = view !== "folders";
  if (view === "folders") renderTree();
}

function renderPanel(): void {
  const node = state.selected ? state.graph?.nodes.find((n) => n.id === state.selected) : undefined;
  panelEl.hidden = !node;
  if (!node || !state.adj) return;
  renderNodePanel(panelEl, node, {
    host,
    incoming: state.adj.incoming.get(node.id) ?? [],
    outgoing: state.adj.outgoing.get(node.id) ?? [],
    onSelect: (target) => {
      select(target);
      network.focus(target);
    },
  });
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
    if (state.selected && !graph.nodes.some((n) => n.id === state.selected)) select(undefined);
    else renderPanel();
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
