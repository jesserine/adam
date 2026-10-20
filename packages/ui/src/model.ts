import type { CodeGraph, GraphNode } from "@adam/core";
import { hierarchy, pack } from "d3-hierarchy";

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
 * The dotted prefix most top-level clusters share, as in .NET solutions (`CPBuild.Domain`,
 * `CPBuild.Host`, ...), so labels can drop it. Empty when there is no such prefix.
 */
export function sharedPrefix(clusters: string[]): string {
  const code = clusters.filter((c) => !isToolFolder(c) && !c.includes("/"));
  if (code.length < 3) return "";
  const counts = new Map<string, number>();
  for (const c of code) {
    const dot = c.indexOf(".");
    if (dot > 0 && dot < c.length - 1) counts.set(c.slice(0, dot + 1), (counts.get(c.slice(0, dot + 1)) ?? 0) + 1);
  }
  const [prefix, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return count >= 3 && count >= code.length * 0.6 ? prefix : "";
}

/** Editor and CI folders (`.idea`, `.vscode`, `.github`): shown, but quieter than code. */
export function isToolFolder(folder: string): boolean {
  return folder.startsWith(".");
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
  for (const n of graph.nodes) {
    const cluster = clusterOf(n);
    if (!isToolFolder(cluster)) counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }
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

// Folding ------------------------------------------------------------------------------------

const GROUP_PREFIX = "\u0000folder:";

/** Network id of a collapsed folder. The prefix cannot appear in a file path, so ids never clash. */
export const groupId = (folder: string): string => GROUP_PREFIX + folder;
export const isGroupId = (id: string): boolean => id.startsWith(GROUP_PREFIX);
export const groupFolder = (id: string): string => id.slice(GROUP_PREFIX.length);

/**
 * Folds files into their folders so a big repo opens as a handful of clusters. Each file has a
 * chain of folders it can fold into, outermost first: its cluster, then each deeper folder.
 * Folders that add nothing are left out of the chain: one that is its parent's only entry
 * (`apps/web/src` under `apps/web`), and one holding a single file.
 */
export class Folding {
  private readonly chains = new Map<string, string[]>();
  private readonly members = new Map<string, string[]>();

  constructor(nodes: Pick<GraphNode, "id" | "folder">[]) {
    const entries = new Map<string, Set<string>>();
    const raw = new Map<string, string[]>();
    for (const n of nodes) {
      const chain = folderChain(n);
      raw.set(n.id, chain);
      chain.forEach((folder, i) => {
        (this.members.get(folder) ?? this.members.set(folder, []).get(folder)!).push(n.id);
        const child = chain[i + 1] ?? n.id;
        (entries.get(folder) ?? entries.set(folder, new Set()).get(folder)!).add(child);
      });
    }
    for (const [id, chain] of raw) {
      this.chains.set(
        id,
        chain.filter((folder, i) => this.members.get(folder)!.length > 1 && (i === 0 || entries.get(chain[i - 1])!.size > 1)),
      );
    }
  }

  /** Every folder that can be collapsed, outermost first. */
  folders(): string[] {
    const all = new Set<string>();
    for (const chain of this.chains.values()) chain.forEach((f) => all.add(f));
    return [...all].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  }

  /** Files under a folder, at any depth. */
  membersOf(folder: string): string[] {
    return this.members.get(folder) ?? [];
  }

  /** What a file shows as: its outermost collapsed folder, or the file itself when every folder above it is open. */
  unitOf(file: string, expanded: ReadonlySet<string>): string {
    const folder = this.chains.get(file)?.find((f) => !expanded.has(f));
    return folder === undefined ? file : groupId(folder);
  }

  /** The open folder a unit sits in, which collapsing the unit closes. Undefined at the top level. */
  parentOf(unit: string): string | undefined {
    if (!isGroupId(unit)) return this.chains.get(unit)?.at(-1);
    const folder = groupFolder(unit);
    const chain = this.chains.get(this.membersOf(folder)[0] ?? "") ?? [];
    return chain[chain.indexOf(folder) - 1];
  }

  /** The folders to open so a file shows on its own. */
  pathTo(file: string): string[] {
    return this.chains.get(file) ?? [];
  }
}

function folderChain(node: Pick<GraphNode, "folder">): string[] {
  const cluster = clusterOf(node);
  if (cluster === ROOT_CLUSTER) return [];
  const chain = [cluster];
  for (const part of node.folder.slice(cluster.length).split("/").filter(Boolean)) chain.push(`${chain.at(-1)}/${part}`);
  return chain;
}

/**
 * Short labels for files: the name alone when it is unique, otherwise just enough of the path
 * to tell them apart, the way editor tabs do (`ui/index.ts`, `web/…/index.ts`).
 */
export function fileLabels(ids: string[]): Map<string, string> {
  const byName = new Map<string, string[][]>();
  for (const id of ids) {
    const parts = id.split("/");
    (byName.get(parts.at(-1)!) ?? byName.set(parts.at(-1)!, []).get(parts.at(-1)!)!).push(parts);
  }
  const labels = new Map<string, string>();
  for (const [name, group] of byName) {
    for (const parts of group) {
      let label = name;
      if (group.length > 1) {
        const suffix = (p: string[], k: number) => p.slice(-k).join("/");
        let k = 2;
        while (k < parts.length && group.some((o) => o !== parts && suffix(o, k) === suffix(parts, k))) k++;
        const dir = parts.at(-k);
        label = dir === undefined ? name : k === 2 ? `${dir}/${name}` : `${dir}/…/${name}`;
      }
      labels.set(parts.join("/"), label);
    }
  }
  return labels;
}

// Regions ------------------------------------------------------------------------------------

export interface Region {
  x: number;
  y: number;
  r: number;
  /** 1 for a cluster (`apps/web`), deeper for folders inside it. */
  depth: number;
}

interface PackNode {
  id: string;
  weight: number;
  children?: PackNode[];
}

/**
 * Lays every file out by region: each cluster gets its own circle, each foldable folder a circle
 * inside it, and files are packed inside their folder with the most connected ones in the middle.
 * The same files always give the same picture, and opening a folder never moves anything.
 */
export function packRegions(
  files: Array<{ id: string; weight: number }>,
  folding: Folding,
): { positions: Map<string, { x: number; y: number }>; regions: Map<string, Region>; size: number } {
  const root: PackNode = { id: "", weight: 0, children: [] };
  const folders = new Map<string, PackNode>();
  for (const f of files) {
    let parent = root;
    for (const folder of folding.pathTo(f.id)) {
      let node = folders.get(folder);
      if (!node) {
        node = { id: folder, weight: 0, children: [] };
        folders.set(folder, node);
        parent.children!.push(node);
      }
      parent = node;
    }
    parent.children!.push({ id: f.id, weight: f.weight });
  }
  const size = 24 * Math.sqrt(Math.max(1, files.length));
  const tree = hierarchy(root)
    .sum((d) => (d.children ? 0 : 1))
    .sort((a, b) => b.value! - a.value! || b.data.weight - a.data.weight || a.data.id.localeCompare(b.data.id));
  const packed = pack<PackNode>()
    .size([size, size])
    .padding((d) => (d.depth === 0 ? 14 : 5))(tree);
  const positions = new Map<string, { x: number; y: number }>();
  const regions = new Map<string, Region>();
  for (const d of packed.descendants()) {
    if (d.depth === 0) continue;
    if (d.data.children) regions.set(d.data.id, { x: d.x, y: d.y, r: d.r, depth: d.depth });
    else positions.set(d.data.id, { x: d.x, y: d.y });
  }
  return { positions, regions, size };
}
