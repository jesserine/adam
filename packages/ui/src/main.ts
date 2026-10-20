import type { CodeGraph } from "@adam/core";
import { collapsible, h } from "./dom";
import { createHost } from "./host";
import { adjacency, buildTree, isGroupId, type TreeEntry } from "./model";
import { NetworkView, type NetworkState, type Theme, type UnitLink } from "./network";
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
  trail: [] as string[],
  /** The node or folder whose panel is open. */
  selected: undefined as string | undefined,
  view: "network" as "network" | "folders",
  /** The file or folder picked in the Folders view, which has its own panel. */
  picked: undefined as string | undefined,
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
const infoTitle = h("h3", {}, "Node info");
const infoSection = collapsible("Node info", { class: "side-info" }, panelEl);
infoSection.querySelector("summary")!.replaceChildren(infoTitle);
const groupsSection = collapsible("Groups", { class: "side-groups" }, h("label", { class: "group-row all" }, selectAll, h("span", {}, "Show all")), groupsEl);

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
        infoSection,
        groupsSection,
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
  state.trail = next.trail;
  state.selected = next.inspected;
  renderFocusBar();
  if (changed) renderPanel();
  markTreeSelection();
}

/**
 * The bar over the network: the breadcrumb of folders opened so far (each one clickable to go
 * back there), then what is focused or being viewed.
 */
function renderFocusBar(): void {
  focusBar.hidden = !(state.focus || state.viewing || state.trail.length) || state.view !== "network";
  const crumbs = state.trail.length
    ? [
        h("nav", { class: "trail", "aria-label": "Folders opened" },
          h("button", { class: "crumb", onclick: () => network.goTo(-1), title: "Back to the overview" }, "All"),
          ...state.trail.flatMap((label, i) => [
            h("span", { class: "sep" }, "›"),
            i === state.trail.length - 1
              ? h("strong", { class: "crumb current" }, label)
              : h("button", { class: "crumb", onclick: () => network.goTo(i), title: `Back to ${label}` }, label),
          ]),
        ),
      ]
    : [];
  if (state.focus) {
    focusBar.replaceChildren(
      ...crumbs,
      h("span", {}, "Focused on ", h("strong", {}, network.labelOf(state.focus))),
      h("span", { class: "hint" }, h("i", { class: "arrow-out" }), "imports"),
      h("span", { class: "hint" }, h("i", { class: "arrow-in" }), "imported by"),
      h("span", { class: "hint" }, "Clicking a node opens its panel and keeps these links."),
      h("button", { class: "ghost", onclick: () => network.clearFocus(), title: "Clear focus (Esc)" }, "Clear focus"),
    );
    return;
  }
  focusBar.replaceChildren(
    ...crumbs,
    ...(state.viewing ? [h("span", { class: "hint" }, "Anything the open folder does not connect to is dimmed.")] : []),
    h("button", { class: "ghost", onclick: () => network.back(), title: "Fold the last folder back (Esc)" }, "Back"),
  );
}

function setView(view: "network" | "folders"): void {
  state.view = view;
  networkTab.classList.toggle("active", view === "network");
  foldersTab.classList.toggle("active", view === "folders");
  networkEl.hidden = view !== "network";
  // The Folders view has its own panel: what is picked in the tree, and no groups.
  groupsSection.hidden = view !== "network";
  treeEl.hidden = view !== "folders";
  infoTitle.textContent = view === "network" ? "Node info" : "Details";
  if (view === "folders") renderTree();
  renderFocusBar();
  renderPanel();
}

/** Picks a file or folder in the Folders view: it opens in the tree and its details fill the panel. */
function pick(id: string): void {
  state.picked = id;
  renderPanel();
  markTreeSelection();
}

/** Leaves the Folders view for the network, with the file focused or the folder opened there. */
function viewInNetwork(id: string): void {
  setView("network");
  if (state.graph?.nodes.some((n) => n.id === id)) network.focusOn(id);
  else network.viewFolder(id);
}

function viewInNetworkButton(id: string): HTMLElement {
  return h("button", { class: "primary", onclick: () => viewInNetwork(id), title: "Show this in the network view" }, "View in network");
}

function renderPanel(): void {
  if (state.view === "folders") return renderFolderPanel();
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
  infoSection.scrollTop = 0;
}

/** The Folders view's panel: the same details as the network's, for whatever is picked in the tree. */
function renderFolderPanel(): void {
  const id = state.picked;
  if (!id || !state.graph || !state.adj) {
    panelEl.replaceChildren(h("p", { class: "empty" }, "Click a file or folder to see its details."));
    return;
  }
  const node = state.graph.nodes.find((n) => n.id === id);
  if (node) {
    renderNodePanel(panelEl, node, {
      host,
      incoming: state.adj.incoming.get(node.id) ?? [],
      outgoing: state.adj.outgoing.get(node.id) ?? [],
      onSelect: pick,
      actions: [viewInNetworkButton(id)],
    });
  } else {
    const files = state.graph.nodes.filter((n) => n.id.startsWith(`${id}/`));
    renderGroupPanel(panelEl, {
      folder: id,
      files,
      ...folderLinks(id),
      onExpand: () => undefined,
      onSelect: pick,
      primary: viewInNetworkButton(id),
    });
  }
  infoSection.scrollTop = 0;
}

/** The folders a folder imports from and is imported by, each by the folder its files sit in, busiest first. */
function folderLinks(folder: string): { outgoing: UnitLink[]; incoming: UnitLink[] } {
  const inside = (id: string) => id.startsWith(`${folder}/`);
  const dir = (id: string) => id.slice(0, id.lastIndexOf("/"));
  const out = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const n of state.graph!.nodes) {
    if (!inside(n.id)) continue;
    for (const e of state.adj!.outgoing.get(n.id) ?? []) if (!inside(e.target)) out.set(dir(e.target), (out.get(dir(e.target)) ?? 0) + 1);
    for (const e of state.adj!.incoming.get(n.id) ?? []) if (!inside(e.source)) inc.set(dir(e.source), (inc.get(dir(e.source)) ?? 0) + 1);
  }
  const list = (m: Map<string, number>) =>
    [...m].map(([unit, count]) => ({ unit, label: `${unit}/`, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { outgoing: list(out), incoming: list(inc) };
}

function renderTree(): void {
  if (!state.graph) return;
  const render = (entries: TreeEntry[], depth: number): HTMLElement => {
    const ul = h("ul", { role: depth === 0 ? "tree" : "group" });
    for (const e of entries) {
      if (e.children) {
        const det = h("details", { open: depth === 0 }, h("summary", { class: "tree-folder", "data-id": e.path, onclick: () => pick(e.path) }, `${e.name}/`), render(e.children, depth + 1));
        ul.append(h("li", {}, det));
      } else {
        ul.append(h("li", {}, h("button", { class: "tree-file", "data-id": e.path, onclick: () => pick(e.path) }, e.name)));
      }
    }
    return ul;
  };
  treeEl.replaceChildren(render(buildTree(state.graph.nodes), 0));
  markTreeSelection();
}

function markTreeSelection(): void {
  treeEl.querySelectorAll<HTMLElement>(".tree-file, .tree-folder").forEach((b) => {
    const on = b.dataset.id === state.picked;
    b.classList.toggle("selected", on);
    if (on) {
      for (let p = b.parentElement?.parentElement; p && p !== treeEl; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
      b.scrollIntoView({ block: "nearest" });
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
