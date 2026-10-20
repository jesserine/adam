import type { CodeGraph, GraphNode } from "@adam/core";

/** Folders that only group other modules, so the cluster is one level deeper. */
const CONTAINER_FOLDERS = new Set(["src", "packages", "apps", "libs", "lib", "app", "modules", "services"]);

export const ROOT_CLUSTER = "(root)";
export const OTHER_CLUSTER = "other";

/** The cluster a node belongs to: its module folder, e.g. `src/lib` or `packages/core`. */
export function clusterOf(node: Pick<GraphNode, "folder">): string {
  if (!node.folder) return ROOT_CLUSTER;
  const parts = node.folder.split("/");
  if (CONTAINER_FOLDERS.has(parts[0]) && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/**
 * Categorical slots, in fixed order (validated palette: blue, orange, aqua, yellow, magenta,
 * green, violet). Red is kept back for sensitive nodes, so a cluster is never mistaken for one.
 */
export const CLUSTER_COLORS = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
};
export const SENSITIVE_COLOR = { light: "#e34948", dark: "#e66767" };
export const OTHER_COLOR = { light: "#9a9a94", dark: "#76766f" };

/**
 * Gives the largest clusters a colour slot each and folds the rest into "other". Slots already
 * handed out are kept across re-indexes, so a cluster's colour follows it, not its rank.
 */
export function assignClusterSlots(graph: CodeGraph, previous = new Map<string, number>()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of graph.nodes) counts.set(clusterOf(n), (counts.get(clusterOf(n)) ?? 0) + 1);
  const slots = new Map<string, number>();
  for (const [cluster, slot] of previous) if (counts.has(cluster)) slots.set(cluster, slot);
  const free = CLUSTER_COLORS.light.map((_, i) => i).filter((i) => ![...slots.values()].includes(i));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  for (const cluster of ranked) {
    if (slots.has(cluster)) continue;
    const slot = free.shift();
    if (slot === undefined) break;
    slots.set(cluster, slot);
  }
  return slots;
}

export interface TreeEntry {
  name: string;
  /** Folder path for folders, node id for files. */
  path: string;
  children?: TreeEntry[];
}

/** Builds the classic folder tree over the same nodes, folders first, then files, by name. */
export function buildTree(nodes: Pick<GraphNode, "id">[]): TreeEntry[] {
  const root: TreeEntry = { name: "", path: "", children: [] };
  for (const { id } of nodes) {
    const parts = id.split("/");
    let dir = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join("/");
      let child = dir.children!.find((c) => c.name === part && !!c.children === !isFile);
      if (!child) {
        child = isFile ? { name: part, path: childPath } : { name: part, path: childPath, children: [] };
        dir.children!.push(child);
      }
      dir = child;
    });
  }
  const sort = (entries: TreeEntry[]) => {
    entries.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));
    entries.forEach((e) => e.children && sort(e.children));
  };
  sort(root.children!);
  return root.children!;
}

/** Incoming and outgoing edges per node, for the panel and for highlighting. */
export function adjacency(graph: CodeGraph) {
  const incoming = new Map<string, CodeGraph["edges"]>();
  const outgoing = new Map<string, CodeGraph["edges"]>();
  for (const e of graph.edges) {
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e);
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e);
  }
  return { incoming, outgoing };
}
