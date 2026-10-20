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
 * Categorical slots, in fixed order: the Tableau palette Graphify uses (blue, orange, teal, green,
 * yellow, purple, pink, brown, light blue, light orange). Its red is kept back for sensitive
 * nodes, so a group is never mistaken for one.
 */
export const CLUSTER_COLORS = {
  light: ["#4e79a7", "#f28e2b", "#76b7b2", "#59a14f", "#e0b52b", "#b07aa1", "#ff9da7", "#9c755f", "#86b3dc", "#ffbe7d"],
  dark: ["#4e79a7", "#f28e2b", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#a0cbe8", "#ffbe7d"],
};
export const SENSITIVE_COLOR = { light: "#e15759", dark: "#e15759" };
export const OTHER_COLOR = { light: "#a8a29c", dark: "#7d7873" };

/**
 * Gives the largest groups a colour slot each and folds the rest into "other". Slots already
 * handed out are kept across re-indexes, so a group's colour follows it, not its rank. Tool
 * folders (`.github`) never get one.
 */
export function assignSlots(counts: Map<string, number>, previous = new Map<string, number>()): Map<string, number> {
  const code = [...counts.entries()].filter(([g, n]) => n > 0 && !isToolFolder(g));
  const slots = new Map<string, number>();
  for (const [group, slot] of previous) if (code.some(([g]) => g === group)) slots.set(group, slot);
  const free = CLUSTER_COLORS.light.map((_, i) => i).filter((i) => ![...slots.values()].includes(i));
  for (const [group] of code.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (slots.has(group)) continue;
    const slot = free.shift();
    if (slot === undefined) break;
    slots.set(group, slot);
  }
  return slots;
}

/** Colour slots for top-level clusters, one per cluster. */
export function assignClusterSlots(graph: CodeGraph, previous = new Map<string, number>()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of graph.nodes) counts.set(clusterOf(n), (counts.get(clusterOf(n)) ?? 0) + 1);
  return assignSlots(counts, previous);
}

/** Files coloured together: each file's group, and how many files each group holds. */
export interface ColorGroups {
  groupOf: Map<string, string>;
  counts: Map<string, number>;
}

/**
 * Splits the repo into colour groups, the way Graphify colours communities: start from the
 * clusters and keep opening the biggest into its subfolders while the groups still fit in `max`
 * colours. A group holding more than a quarter of the files is opened even past that (up to three
 * times `max` groups, the extra ones grey) when one of its subfolders is a fifth of it or more, so one huge package never paints the screen one
 * colour. A three-package monorepo then shows `web/routes`, `web/lib`, `ui` and `domain` in their
 * own colours instead of one blue blob. Tool folders and root files are never split.
 */
export function colorGroups(nodes: Pick<GraphNode, "id" | "folder">[], folding: Folding, max = CLUSTER_COLORS.light.length): ColorGroups {
  const children = new Map<string, string[]>();
  for (const f of folding.folders()) {
    const parent = folding.parentOf(groupId(f));
    if (parent !== undefined) (children.get(parent) ?? children.set(parent, []).get(parent)!).push(f);
  }
  const keys = new Set(nodes.map(clusterOf));
  const assign = (): ColorGroups => {
    const groupOf = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const g = [...folding.pathTo(n.id)].reverse().find((f) => keys.has(f)) ?? clusterOf(n);
      groupOf.set(n.id, g);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return { groupOf, counts };
  };
  const live = (c: ColorGroups) => [...c.counts.keys()].filter((g) => !isToolFolder(g)).length;
  const code = nodes.filter((n) => !isToolFolder(clusterOf(n))).length;
  let current = assign();
  for (;;) {
    const candidates = [...current.counts.entries()]
      .filter(([g]) => !isToolFolder(g) && children.has(g))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    let split = false;
    for (const [g] of candidates) {
      const kids = children.get(g)!.filter((k) => !keys.has(k));
      if (!kids.length) continue;
      kids.forEach((k) => keys.add(k));
      const next = assign();
      // Past the limit, only a dominant group whose subfolders are real parts of it (not a dozen
      // equal crumbs) is opened.
      const size = current.counts.get(g)!;
      const biggestKid = Math.max(...kids.map((k) => next.counts.get(k) ?? 0));
      const dominant = size > code * 0.25 && biggestKid >= size * 0.2;
      if (live(next) <= max || (dominant && live(next) <= max * 3)) {
        current = next;
        split = true;
        break;
      }
      kids.forEach((k) => keys.delete(k));
    }
    if (!split) return current;
  }
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
