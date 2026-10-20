import type { CodeGraph } from "@adam/core";
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
  viewing: undefined as string | undefined,
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
const groupsEl = h("div", { class: "groups", "aria-label": "Groups" });
const selectAll = h("input", { type: "checkbox", checked: true, "aria-label": "Show every group" });
const networkEl = h("div", { class: "network" });
const treeEl = h("div", { class: "tree", hidden: true });
const panelEl = h("div", { class: "panel" });
const statusEl = h("div", { class: "status", hidden: true });
const focusBar = h("div", { class: "focus-bar", hidden: true });

document.body.append(
  h(
    "div",
    { class: "app" },
    h(
      "header",
      { class: "toolbar" },
      h("span", { class: "brand" }, "Adam"),
      h("div", { class: "tabs", role: "tablist" }, networkTab, foldersTab),
      h("label", { class: "filter" }, hideUnconnected, "Hide unconnected"),
      h("label", { class: "filter" }, hideTypeOnly, "Hide type-only imports"),
      h("button", { class: "ghost", onclick: () => void reindex(), title: "Re-index the repository" }, "Re-index"),
      h("button", { class: "ghost", onclick: () => network.expandAll(), title: "Show every file" }, "Expand all"),
      h("button", { class: "ghost", onclick: () => network.collapseAll(), title: "Fold every folder back into its cluster" }, "Collapse all"),
      h("button", { class: "ghost", onclick: () => network.fit(), title: "Fit what is on screen" }, "Fit"),
    ),
    h(
      "main",
      { class: "main" },
      h("div", { class: "canvas" }, networkEl, treeEl, focusBar, statusEl),
      // A sidebar like Graphify's: search, the inspected node, and the groups with show/hide toggles.
      h(
        "aside",
        { class: "sidebar" },
        h("div", { class: "side-search" }, search, datalist),
        h("section", { class: "side-info" }, h("h3", {}, "Node info"), panelEl),
        h("section", { class: "side-groups" }, h("h3", {}, "Groups"), h("label", { class: "group-row all" }, selectAll, h("span", {}, "Show all")), groupsEl),
        h("footer", { class: "side-stats" }, stats),
      ),
    ),
  ),
);

const network = new NetworkView(networkEl, detectTheme(), (s) => onNetworkChange(s));

new MutationObserver(() => {
  network.setTheme(detectTheme());
  renderGroups();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

const applyFilters = () => network.setFilters({ hideUnconnected: hideUnconnected.checked, hideTypeOnly: hideTypeOnly.checked });
hideUnconnected.addEventListener("change", applyFilters);
hideTypeOnly.addEventListener("change", applyFilters);
selectAll.addEventListener("change", () => {
  network.setAllGroups(selectAll.checked);
  renderGroups();
});

search.addEventListener("change", () => findNode(search.value));
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") findNode(search.value);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) network.back();
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
  state.viewing = next.viewing;
  state.selected = next.inspected;
  renderFocusBar();
  if (changed) renderPanel();
  markTreeSelection();
}

function renderFocusBar(): void {
  focusBar.hidden = !(state.focus || state.viewing) || state.view !== "network";
  if (!state.focus) {
    if (state.viewing) {
      focusBar.replaceChildren(
        h("span", {}, "Viewing ", h("strong", {}, state.viewing)),
        h("span", { class: "hint" }, "Anything it does not connect to is dimmed."),
        h("button", { class: "ghost", onclick: () => network.back(), title: "Stop viewing (Esc)" }, "Show all"),
      );
    }
    return;
  }
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
  groupsEl.closest("section")!.hidden = view !== "network";
  treeEl.hidden = view !== "folders";
  if (view === "folders") renderTree();
  renderFocusBar();
}

function renderPanel(): void {
  const id = state.selected;
  if (!id || !state.graph || !state.adj) {
    panelEl.replaceChildren(h("p", { class: "empty" }, "Click a node to inspect it."));
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
      panelEl.replaceChildren(h("p", { class: "empty" }, "Click a node to inspect it."));
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
  panelEl.closest("section")!.scrollTop = 0;
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

/** The groups list: a colour, a name and a file count per group, each with a show/hide checkbox. */
function renderGroups(): void {
  const groups = network.legend();
  const hidden = groups.filter((g) => g.hidden).length;
  selectAll.checked = hidden === 0;
  selectAll.indeterminate = hidden > 0 && hidden < groups.length;
  groupsEl.replaceChildren(
    ...groups.map((g) => {
      const box = h("input", { type: "checkbox", checked: !g.hidden });
      box.addEventListener("change", () => {
        network.toggleGroup(g.key);
        renderGroups();
      });
      return h("label", { class: "group-row", title: g.label }, box, h("i", { style: `background:${g.color}` }), h("span", { class: "group-name" }, g.label), h("span", { class: "group-count" }, `${g.count}`));
    }),
    h("div", { class: "group-row note" }, h("i", { style: `background:${network.sensitiveColor()}` }), h("span", { class: "group-name" }, "sensitive files (masked)")),
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
    renderGroups();
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
