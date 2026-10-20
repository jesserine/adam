import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import { packEnclose, packSiblings } from "d3-hierarchy";

/** What the layout needs to know about the repo. */
export interface LayoutInput {
  files: string[];
  /** Files a file imports. */
  outgoing: (file: string) => string[];
  /** Each file's colour group. */
  groupOf: Map<string, string>;
  /** The folders a file folds into, outermost first. */
  pathTo: (file: string) => string[];
  /** A file's drawn radius, in pixels. */
  size: (file: string) => number;
}

/** A file or folder being placed by arrange(): a disc of radius `r`. */
interface ArrangeItem {
  id: string;
  r: number;
  files: string[];
  sub?: Arranged;
}

/** Files placed around 0,0, and the radius they need. */
interface Arranged {
  at: Map<string, { x: number; y: number }>;
  /** The centre of each subfolder's area. */
  folders: Map<string, { x: number; y: number }>;
  radius: number;
}

/**
 * Lays files out group by group, so every colour group has its own area with clear space
 * around it, and inside a group every subfolder has its own area too. At each level the
 * entries (files and subfolders, a subfolder sized to fit everything in it) are packed tightly
 * by arrange(). The groups themselves are placed by ForceAtlas2, weighted by the imports
 * between them, so groups that talk sit side by side, and noverlap keeps a wide gap between them.
 * A collapsed folder sits in the middle of its own area, so it never lands on another node.
 * Everything is seeded from file names, so the same repo always draws the same way.
 */
export function layoutByGroup(input: LayoutInput): {
  positions: Map<string, { x: number; y: number }>;
  groups: Map<string, { x: number; y: number; r: number }>;
  folders: Map<string, { x: number; y: number }>;
} {
  const groupOf = input.groupOf;
  const members = new Map<string, string[]>();
  for (const f of input.files) (members.get(groupOf.get(f)!) ?? members.set(groupOf.get(f)!, []).get(groupOf.get(f)!)!).push(f);

  // 1. Each group on its own: its folders, nested, each in its own area.
  const local = new Map<string, Arranged>();
  for (const [group, files] of members) {
    const paths = new Map(files.map((f) => [f, input.pathTo(f).filter((d) => d.startsWith(`${group}/`))]));
    local.set(group, arrangeFolder(input, files, paths, 0));
  }

  // 2. The groups as discs, linked by how many imports run between them.
  const meta = new Graph({ multi: false, type: "undirected" });
  const order = [...members.keys()].sort((a, b) => members.get(b)!.length - members.get(a)!.length || a.localeCompare(b));
  const total = Math.sqrt(order.reduce((sum, g) => sum + (2 * local.get(g)!.radius) ** 2, 0));
  order.forEach((group, i) => {
    // Start on a sunflower spiral, biggest in the middle.
    const r = (total / 2) * Math.sqrt(i / Math.max(1, order.length));
    meta.addNode(group, { x: r * Math.cos(i * 2.39996), y: r * Math.sin(i * 2.39996), size: local.get(group)!.radius });
  });
  for (const f of input.files) for (const t of input.outgoing(f)) {
    const [a, b] = [groupOf.get(f)!, groupOf.get(t)!];
    if (b === undefined) continue;
    if (a === b) continue;
    if (meta.hasEdge(a, b)) meta.updateEdgeAttribute(a, b, "weight", (w) => (w as number) + 1);
    else meta.addEdge(a, b, { weight: 1 });
  }
  if (meta.order > 1) {
    forceAtlas2.assign(meta, { iterations: 300, getEdgeWeight: "weight", settings: { ...forceAtlas2.inferSettings(meta), gravity: 2, edgeWeightInfluence: 0.5 } });
    // Scale back to the packed size before pushing discs apart, so groups end up close but clear.
    let r = 1;
    meta.forEachNode((_, a) => (r = Math.max(r, Math.hypot(a.x as number, a.y as number))));
    meta.forEachNode((id, a) => meta.mergeNodeAttributes(id, { x: ((a.x as number) / r) * total * 0.5, y: ((a.y as number) / r) * total * 0.5 }));
    noverlap.assign(meta, { maxIterations: 300, settings: { margin: 40, ratio: 1, expansion: 1.05 } });
  }
  const groups = new Map<string, { x: number; y: number; r: number }>();
  meta.forEachNode((group, a) => groups.set(group, { x: a.x as number, y: a.y as number, r: local.get(group)!.radius }));
  const positions = new Map<string, { x: number; y: number }>();
  for (const f of input.files) {
    const c = groups.get(groupOf.get(f)!)!;
    const q = local.get(groupOf.get(f)!)!.at.get(f)!;
    positions.set(f, { x: c.x + q.x, y: c.y + q.y });
  }
  // A group's own folder sits at the group's centre; its subfolders at the centres of their areas.
  const folders = new Map<string, { x: number; y: number }>();
  for (const [group, c] of groups) {
    folders.set(group, { x: c.x, y: c.y });
    for (const [d, p] of local.get(group)!.folders) folders.set(d, { x: c.x + p.x, y: c.y + p.y });
  }
  return { positions, groups, folders };
}

/** Arranges a folder's files and subfolders (recursively), centred on 0,0. */
function arrangeFolder(input: LayoutInput, files: string[], paths: Map<string, string[]>, depth: number): Arranged {
  const kids = new Map<string, string[]>();
  for (const f of files) {
    const key = paths.get(f)![depth] ?? `\u0000file:${f}`;
    (kids.get(key) ?? kids.set(key, []).get(key)!).push(f);
  }
  const items: ArrangeItem[] = [...kids].map(([key, fs]) => {
    if (key.startsWith("\u0000file:")) return { id: key, r: input.size(fs[0]) + 12, files: fs };
    const sub = arrangeFolder(input, fs, paths, depth + 1);
    return { id: key, r: sub.radius, files: fs, sub };
  });
  const placed = arrange(input, items);
  const at = new Map<string, { x: number; y: number }>();
  const folders = new Map<string, { x: number; y: number }>();
  for (const item of items) {
    const c = placed.at.get(item.id)!;
    if (!item.sub) {
      at.set(item.files[0], c);
      continue;
    }
    folders.set(item.id, c);
    for (const [f, p] of item.sub.at) at.set(f, { x: c.x + p.x, y: c.y + p.y });
    for (const [d, p] of item.sub.folders) folders.set(d, { x: c.x + p.x, y: c.y + p.y });
  }
  return { at, folders, radius: placed.radius };
}

/**
 * Places discs (a file is a small one, a folder or group a bigger one) tightly, none
 * overlapping, with a gap for labels. Folders go first, biggest first; files follow in the order
 * a quick ForceAtlas2 run puts them around the middle, so files that import each other end up
 * next to each other. d3's packSiblings does the packing. Returns each disc's centre, relative
 * to the middle, and the radius of the whole arrangement.
 */
function arrange(input: LayoutInput, items: ArrangeItem[]): { at: Map<string, { x: number; y: number }>; radius: number } {
  const at = new Map<string, { x: number; y: number }>();
  if (items.length === 1) {
    at.set(items[0].id, { x: 0, y: 0 });
    return { at, radius: items[0].r };
  }
  const angle = angles(input, items);
  const gap = items.some((i) => i.sub) ? 16 : 10;
  const circles = items
    .map((i) => ({ id: i.id, folder: !!i.sub, x: 0, y: 0, r: i.r + gap, angle: angle.get(i.id)! }))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || (a.folder ? b.r - a.r : a.angle - b.angle) || a.id.localeCompare(b.id));
  packSiblings(circles);
  const hull = packEnclose(circles)!;
  for (const c of circles) at.set(c.id, { x: c.x - hull.x, y: c.y - hull.y });
  return { at, radius: hull.r + 2 };
}

/** Where each entry sits around the middle after ForceAtlas2, as an angle: linked entries get close angles. */
function angles(input: LayoutInput, items: ArrangeItem[]): Map<string, number> {
  const g = new Graph({ multi: false, type: "undirected" });
  const itemOf = new Map<string, string>();
  for (const item of items) {
    const h = hash(item.id);
    g.addNode(item.id, { x: (h % 1000) - 500, y: ((h >>> 10) % 1000) - 500 });
    for (const f of item.files) itemOf.set(f, item.id);
  }
  for (const item of items) {
    for (const f of item.files) {
      for (const t of input.outgoing(f)) {
        const other = itemOf.get(t);
        if (other === undefined || other === item.id) continue;
        if (g.hasEdge(item.id, other)) g.updateEdgeAttribute(item.id, other, "weight", (w) => (w as number) + 1);
        else g.addEdge(item.id, other, { weight: 1 });
      }
    }
  }
  if (g.size > 0) {
    forceAtlas2.assign(g, {
      iterations: items.length < 300 ? 120 : 50,
      getEdgeWeight: "weight",
      settings: { ...forceAtlas2.inferSettings(g), linLogMode: true, strongGravityMode: true, barnesHutOptimize: items.length > 1000 },
    });
  }
  let [cx, cy] = [0, 0];
  g.forEachNode((_, a) => ((cx += (a.x as number) / g.order), (cy += (a.y as number) / g.order)));
  const out = new Map<string, number>();
  g.forEachNode((id, a) => out.set(id, Math.atan2((a.y as number) - cy, (a.x as number) - cx)));
  return out;
}

/** A small stable hash, so a file's starting spot is the same on every load. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
