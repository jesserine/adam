import type { CodeGraph } from "@adam/core";
import EdgeCurveProgram, { EdgeCurvedArrowProgram } from "@sigma/edge-curve";
import { createNodeBorderProgram } from "@sigma/node-border";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import Sigma from "sigma";
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
import {
  adjacency,
  assignSlots,
  CLUSTER_COLORS,
  clusterOf,
  colorGroups,
  type ColorGroups,
  fileLabels,
  Folding,
  groupFolder,
  isGroupId,
  isToolFolder,
  sharedPrefix,
  OTHER_COLOR,
  ROOT_CLUSTER,
  SENSITIVE_COLOR,
} from "./model";

export interface NetworkFilters {
  hideUnconnected: boolean;
  hideTypeOnly: boolean;
}

export type Theme = "light" | "dark";

/**
 * What the view is showing: the focus (by label), whose links stay on screen; the folder being
 * viewed (the last one opened), which keeps what it connects to bright; and the open panel.
 */
export interface NetworkState {
  focus: string | undefined;
  viewing: string | undefined;
  inspected: string | undefined;
}

/** A unit's links to other units, counted in file-level imports. */
export interface UnitLink {
  unit: string;
  label: string;
  count: number;
}

/** Above this many files, the network opens with each colour group collapsed into one node. */
const COLLAPSE_ABOVE = 150;

/** One entry in the groups legend. `key` is what toggleGroup() takes. */
export interface LegendGroup {
  key: string;
  label: string;
  color: string;
  count: number;
  hidden: boolean;
}

/** The legend key for every group without a colour of its own. */
const OTHER_KEY = "\u0000other";

interface Lit {
  /** Focus and hover light a node's links; viewing an opened folder dims what it does not touch. */
  mode: "focus" | "view";
  units: Set<string>;
  neighbours: Set<string>;
  /** On-screen edges that touch the lit files, and which way they point. */
  edges: Map<string, "out" | "in" | "view">;
}

/**
 * The network view: a WebGL graph of nodes (files) and edges (imports), rendered with Sigma and
 * styled after Graphify: one force layout, colour groups, node size by links, labels on hubs only.
 * Folders can be collapsed into one node each, and a focused node keeps its links on screen
 * until it is cleared, however many of its neighbours are clicked in the meantime.
 */
export class NetworkView {
  /** What is on screen: files and collapsed folders ("units"), with edges summed between them. */
  private readonly graph = new Graph({ multi: false, type: "directed" });
  private readonly sigma: Sigma;
  private data: CodeGraph = { nodes: [], edges: [] } as unknown as CodeGraph;
  private adj = adjacency(this.data);
  private folding = new Folding([]);
  private expanded = new Set<string>();
  /** Positions from one layout of every file, so opening a folder never moves anything else. */
  private positions = new Map<string, { x: number; y: number }>();
  private groups: ColorGroups = { groupOf: new Map(), counts: new Map() };
  private hiddenGroups = new Set<string>();
  private maxDegree = 1;
  /** Files with at least this many links are hubs and always named. */
  private hubDegree = 3;
  private labels = new Map<string, string>();
  /** A dotted prefix most clusters share (`CPBuild.`), left off folder labels on the canvas. */
  private prefix = "";
  private unitOfFile = new Map<string, string>();
  private slots = new Map<string, number>();
  private filters: NetworkFilters = { hideUnconnected: false, hideTypeOnly: false };

  private focusFiles: Set<string> | undefined;
  private focusLabel: string | undefined;
  private viewing: { folder: string; files: Set<string> } | undefined;
  private inspected: string | undefined;
  private hovered: string | undefined;
  private labelQueue: Array<{ text: string; x: number; y: number; rank: number; size: number }> = [];
  private lit: Lit | undefined;
  /** A click on a folder waits out the double-click window, so a double-click only opens the folder. */
  private pendingClick: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly container: HTMLElement,
    private theme: Theme,
    private readonly onChange: (state: NetworkState) => void,
  ) {
    const drawLabel: NodeLabelDrawingFunction = (ctx, data, settings) => this.drawLabel(ctx, data, settings);
    const drawHover: NodeHoverDrawingFunction = (ctx, data, settings) => this.drawHover(ctx, data, settings);
    this.sigma = new Sigma(this.graph, container, {
      defaultEdgeType: "curve",
      edgeProgramClasses: { curve: EdgeCurveProgram, curvedArrow: EdgeCurvedArrowProgram },
      renderEdgeLabels: false,
      // Labels are picked in drawLabel() (hubs, folders, the focus), so Sigma offers them all.
      labelRenderedSizeThreshold: 3,
      labelDensity: 1,
      labelGridCellSize: 100,
      labelFont: "system-ui, -apple-system, Segoe UI, sans-serif",
      labelColor: { color: this.ink() },
      zIndex: true,
      defaultDrawNodeLabel: drawLabel,
      defaultDrawNodeHover: drawHover,
      nodeProgramClasses: {
        folder: createNodeBorderProgram({
          borders: [
            { size: { value: 0.22 }, color: { attribute: "borderColor" } },
            { size: { fill: true }, color: { attribute: "color" } },
          ],
          drawLabel,
          drawHover,
        }),
      },
      nodeReducer: (node, data) => {
        if (this.isHidden(node)) return { ...data, hidden: true };
        const res = { ...data };
        if (node === this.inspected) Object.assign(res, { highlighted: true, forceLabel: true, zIndex: 3 });
        const lit = this.lit;
        if (!lit) return res;
        if (lit.mode === "view" && (lit.units.has(node) || lit.neighbours.has(node))) return res;
        if (lit.mode === "view" && node !== this.inspected) {
          const faded = this.faded();
          return { ...res, color: faded, borderColor: faded, label: "", size: (data.size as number) * 0.7, zIndex: 0 };
        }
        if (lit.units.has(node)) return { ...res, highlighted: true, forceLabel: true, zIndex: 2 };
        // Up to a few dozen neighbours all get labels; past that, Sigma's label grid picks which fit.
        if (lit.neighbours.has(node)) return { ...res, forceLabel: res.forceLabel || lit.neighbours.size <= 30, zIndex: Math.max(res.zIndex ?? 0, 1) };
        if (node === this.inspected) return res;
        const faded = this.faded();
        return { ...res, color: faded, borderColor: faded, label: "", size: Math.min(4, (data.size as number) * 0.5), zIndex: 0 };
      },
      edgeReducer: (edge, data) => {
        if (this.filters.hideTypeOnly && this.graph.getEdgeAttribute(edge, "typeOnly")) return { ...data, hidden: true };
        const lit = this.lit;
        if (!lit) return data;
        const dir = lit.edges.get(edge);
        if (!dir) return { ...data, hidden: true };
        if (dir === "view") return data;
        const [s, t] = this.graph.extremities(edge);
        const strong = this.inspected !== undefined && !lit.units.has(this.inspected) && (s === this.inspected || t === this.inspected);
        return {
          ...data,
          type: "curvedArrow",
          color: dir === "out" ? this.ink() : this.inColor(),
          size: strong ? 3 : 1.2 + Math.min(2, Math.log2(data.count as number) * 0.4),
          zIndex: strong ? 2 : 1,
        };
      },
    });

    this.sigma.on("clickNode", ({ node }) => {
      clearTimeout(this.pendingClick);
      if (!isGroupId(node)) return this.activate(node);
      this.pendingClick = setTimeout(() => this.activate(node), this.sigma.getSetting("doubleClickTimeout") ?? 300);
    });
    this.sigma.on("doubleClickNode", ({ node, event }) => {
      event.preventSigmaDefault();
      clearTimeout(this.pendingClick);
      if (isGroupId(node)) this.toggle(node);
    });
    this.sigma.on("clickStage", () => this.back());
    this.sigma.on("beforeRender", () => (this.labelQueue = []));
    this.sigma.on("afterRender", () => this.drawLabels());
    this.sigma.on("enterNode", ({ node }) => {
      container.style.cursor = "pointer";
      this.hovered = node;
      if (!this.focusFiles) this.relight();
    });
    this.sigma.on("leaveNode", () => {
      container.style.cursor = "default";
      this.hovered = undefined;
      if (!this.focusFiles) this.relight();
    });
  }

  /** Loads a graph, keeping positions for files that were already laid out and folders already open. */
  load(data: CodeGraph): void {
    const firstLoad = !this.data.nodes.length;
    this.data = data;
    this.adj = adjacency(data);
    this.folding = new Folding(data.nodes);
    this.labels = fileLabels(data.nodes.map((n) => n.id));
    this.prefix = sharedPrefix([...new Set(data.nodes.map(clusterOf))]);
    const degrees = data.nodes.map((n) => this.degree(n.id)).sort((a, b) => b - a);
    this.maxDegree = Math.max(1, degrees[0] ?? 0);
    // Hubs: the busiest few files (about one in sixteen), and never one with only a couple of links.
    this.hubDegree = Math.max(3, this.maxDegree * 0.15, degrees[Math.max(4, Math.round(degrees.length / 16))] ?? 0);
    this.groups = colorGroups(data.nodes, this.folding);
    this.slots = assignSlots(this.groups.counts, this.slots);
    if (firstLoad) {
      // Small repos open fully; big ones open down to their colour groups, one node each.
      const keys = [...this.groups.counts.keys()].filter((g) => !isToolFolder(g));
      const folders = this.folding.folders();
      this.expanded = new Set(data.nodes.length <= COLLAPSE_ABOVE ? folders : folders.filter((f) => keys.some((g) => g.startsWith(`${f}/`))));
    }
    this.layout();
    if (this.focusFiles) {
      const ids = new Set(data.nodes.map((n) => n.id));
      this.focusFiles = new Set([...this.focusFiles].filter((f) => ids.has(f)));
      if (!this.focusFiles.size) this.focusFiles = this.focusLabel = undefined;
    }
    this.rebuild();
    if (firstLoad) this.fit(false);
  }

  /** Click semantics: with nothing focused, focus the unit; while focused, only open its panel. */
  activate(id: string): void {
    const unit = this.show(id);
    if (!unit) return;
    if (!this.focusFiles) {
      this.focusFiles = new Set(this.filesOf(unit));
      this.focusLabel = this.labelOf(unit);
    }
    this.inspected = unit;
    this.relight();
    this.emit();
  }

  /** Drops any focus and focuses this node instead, then moves the camera to it. Used by search. */
  focusOn(id: string): void {
    this.focusFiles = this.focusLabel = undefined;
    this.activate(id);
    const unit = this.unitFor(id);
    const pos = unit && this.sigma.getNodeDisplayData(unit);
    if (pos) void this.sigma.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.4 }, { duration: 400 });
  }

  clearFocus(): void {
    if (!this.focusFiles && !this.inspected) return;
    this.focusFiles = this.focusLabel = this.inspected = undefined;
    this.relight();
    this.emit();
  }

  /** One step back, like Esc or a click on empty space: first the focus, then the folder being viewed. */
  back(): void {
    if (this.focusFiles || this.inspected) return this.clearFocus();
    if (!this.viewing) return;
    this.viewing = undefined;
    this.relight();
    this.emit();
  }

  /** Opens a collapsed folder and views it, or closes the folder a node sits in. */
  toggle(unit: string): void {
    if (isGroupId(unit)) {
      const folder = groupFolder(unit);
      this.expanded.add(folder);
      this.viewing = { folder, files: new Set(this.folding.membersOf(folder)) };
      this.rebuild();
      this.frameFiles(this.viewing.files);
      return;
    }
    const parent = this.folding.parentOf(unit);
    if (parent === undefined) return;
    for (const f of [...this.expanded]) if (f === parent || f.startsWith(`${parent}/`)) this.expanded.delete(f);
    if (this.viewing && (this.viewing.folder === parent || this.viewing.folder.startsWith(`${parent}/`))) this.viewing = undefined;
    this.rebuild();
  }

  /** Whether a unit can be collapsed into a folder above it. */
  canCollapse(unit: string): boolean {
    return this.folding.parentOf(unit) !== undefined;
  }

  expandAll(): void {
    this.expanded = new Set(this.folding.folders());
    this.viewing = undefined;
    this.rebuild();
    this.fit();
  }

  collapseAll(): void {
    this.expanded.clear();
    this.viewing = undefined;
    this.rebuild();
    this.fit();
  }

  /** A collapsed folder's path and files. */
  groupInfo(unit: string): { folder: string; files: string[] } {
    const folder = groupFolder(unit);
    return { folder, files: this.folding.membersOf(folder) };
  }

  /** Units a unit imports from and is imported by, as on screen now, busiest first. */
  links(unit: string): { outgoing: UnitLink[]; incoming: UnitLink[] } {
    const files = new Set(this.filesOf(unit));
    const out = new Map<string, number>();
    const inc = new Map<string, number>();
    for (const f of files) {
      for (const e of this.adj.outgoing.get(f) ?? []) if (!files.has(e.target)) bump(out, this.unitFor(e.target)!);
      for (const e of this.adj.incoming.get(f) ?? []) if (!files.has(e.source)) bump(inc, this.unitFor(e.source)!);
    }
    const list = (m: Map<string, number>) =>
      [...m.entries()].map(([u, count]) => ({ unit: u, label: this.labelOf(u), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { outgoing: list(out), incoming: list(inc) };
  }

  labelOf(unit: string): string {
    if (isGroupId(unit)) return `${groupFolder(unit)}/`;
    return this.labels.get(unit) ?? unit;
  }

  /** A cluster by its full path (`packages/ui`); a folder inside one from the cluster's own name (`ui/components`). */
  private groupName(folder: string, cluster: string): string {
    const name = this.prefix && cluster.startsWith(this.prefix) ? cluster.slice(this.prefix.length) : cluster;
    if (folder === cluster) return name;
    return `${name.split("/").at(-1)}${folder.slice(cluster.length)}`;
  }

  /** Frames what is on screen now, which for a collapsed repo is much less than the whole layout. */
  fit(animate = true): void {
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    this.graph.forEachNode((id) => {
      const d = this.isHidden(id) ? undefined : this.sigma.getNodeDisplayData(id);
      if (!d) return;
      [minX, maxX, minY, maxY] = [Math.min(minX, d.x), Math.max(maxX, d.x), Math.min(minY, d.y), Math.max(maxY, d.y)];
    });
    if (!Number.isFinite(minX)) return void this.sigma.getCamera().animatedReset({ duration: animate ? 300 : 0 });
    this.frame(minX, maxX, minY, maxY, animate);
  }

  /** Moves the camera onto a set of files, such as a folder that was just opened. */
  private frameFiles(files: Set<string>): void {
    const toFramed = (p: { x: number; y: number }) => this.sigma.viewportToFramedGraph(this.sigma.graphToViewport(p));
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const f of files) {
      const p = this.positions.get(f);
      if (!p) continue;
      const q = toFramed(p);
      [minX, maxX, minY, maxY] = [Math.min(minX, q.x), Math.max(maxX, q.x), Math.min(minY, q.y), Math.max(maxY, q.y)];
    }
    if (Number.isFinite(minX)) this.frame(minX, maxX, minY, maxY, true);
  }

  private frame(minX: number, maxX: number, minY: number, maxY: number, animate: boolean): void {
    const camera = this.sigma.getCamera();
    const state = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio: Math.min(3, Math.max(0.08, Math.max(maxX - minX, maxY - minY) * 1.25)) };
    if (animate) void camera.animate(state, { duration: 400 });
    else camera.setState(state);
  }

  setFilters(filters: NetworkFilters): void {
    this.filters = filters;
    this.relight();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.sigma.setSetting("labelColor", { color: this.ink() });
    this.rebuild();
  }

  /** The groups legend, biggest first, then one "other" entry for every group without a colour. */
  legend(): LegendGroup[] {
    const items: LegendGroup[] = [...this.slots.keys()]
      .map((key) => ({ key, label: this.groupLabel(key), color: this.colorFor(key, false), count: this.groups.counts.get(key) ?? 0, hidden: this.hiddenGroups.has(key) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const others = [...this.groups.counts.entries()].filter(([g]) => !this.slots.has(g));
    if (others.length) {
      const count = others.reduce((sum, [, n]) => sum + n, 0);
      items.push({ key: OTHER_KEY, label: "other folders", color: OTHER_COLOR[this.theme], count, hidden: this.hiddenGroups.has(OTHER_KEY) });
    }
    return items;
  }

  /** Shows or hides one legend group's nodes. */
  toggleGroup(key: string): void {
    if (!this.hiddenGroups.delete(key)) this.hiddenGroups.add(key);
    this.relight();
  }

  /** Shows every group, or hides them all. */
  setAllGroups(visible: boolean): void {
    this.hiddenGroups = visible ? new Set() : new Set(this.legend().map((g) => g.key));
    this.relight();
  }

  sensitiveColor(): string {
    return SENSITIVE_COLOR[this.theme];
  }

  /** A group's name as the legend shows it: `web/routes`, `ui`, or root files. */
  private groupLabel(group: string): string {
    if (group === ROOT_CLUSTER) return "root files";
    return this.groupName(group, clusterOf({ folder: group }));
  }

  hasNode(id: string): boolean {
    return this.unitOfFile.has(id) || this.graph.hasNode(id);
  }

  destroy(): void {
    this.sigma.kill();
  }

  // Building the view --------------------------------------------------------------------------

  /**
   * One force layout of every file, like Graphify's: ForceAtlas2 in LinLog mode pulls tightly
   * coupled files into clumps. Each colour group also gets an invisible anchor its files are tied
   * to, so a group stays in one place and files with no imports sit with their group instead of
   * drifting to the edge. Finally noverlap nudges nodes apart so none hide another.
   */
  private layout(): void {
    const g = new Graph({ multi: false, type: "undirected" });
    const groups = [...this.groups.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const anchor = (group: string) => `\u0000anchor:${group}`;
    groups.forEach(([group], i) => {
      // Groups start on a sunflower spiral, biggest in the middle.
      const r = 60 * Math.sqrt(i);
      g.addNode(anchor(group), { x: r * Math.cos(i * 2.39996), y: r * Math.sin(i * 2.39996) });
    });
    for (const n of this.data.nodes) {
      const a = g.getNodeAttributes(anchor(this.groups.groupOf.get(n.id)!));
      const h = hash(n.id);
      g.addNode(n.id, this.positions.get(n.id) ?? { x: (a.x as number) + (h % 41) - 20, y: (a.y as number) + ((h >> 8) % 41) - 20 });
      g.addEdge(n.id, anchor(this.groups.groupOf.get(n.id)!), { weight: 0.4 });
    }
    for (const e of this.data.edges) {
      if (e.source === e.target || g.hasEdge(e.source, e.target)) continue;
      const same = this.groups.groupOf.get(e.source) === this.groups.groupOf.get(e.target);
      g.addEdge(e.source, e.target, { weight: same ? 2 : 1 });
    }

    const fresh = this.data.nodes.filter((n) => !this.positions.has(n.id)).length;
    const n = g.order;
    if (n > 1 && fresh > 0) {
      forceAtlas2.assign(g, {
        iterations: this.positions.size ? 60 : n < 500 ? 400 : n < 3000 ? 200 : 80,
        getEdgeWeight: "weight",
        settings: { ...forceAtlas2.inferSettings(g), linLogMode: true, edgeWeightInfluence: 1, barnesHutOptimize: n > 1000 },
      });
      // noverlap works in layout units, so node sizes are scaled from pixels to a ~900px frame.
      let extent = 1;
      g.forEachNode((_, a) => (extent = Math.max(extent, Math.abs(a.x as number), Math.abs(a.y as number))));
      const scale = (2 * extent) / 900;
      g.forEachNode((id) => g.setNodeAttribute(id, "size", id.startsWith("\u0000") ? 0 : (this.fileSize(id) + 1.5) * scale));
      noverlap.assign(g, { maxIterations: 60, settings: { margin: 1.5 * scale, ratio: 1, expansion: 1.05 } });
    }

    this.positions = new Map();
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const node of this.data.nodes) {
      const a = g.getNodeAttributes(node.id);
      const p = { x: a.x as number, y: a.y as number };
      this.positions.set(node.id, p);
      [minX, maxX, minY, maxY] = [Math.min(minX, p.x), Math.max(maxX, p.x), Math.min(minY, p.y), Math.max(maxY, p.y)];
    }
    // Fixed framing: opening or closing a folder must not rescale the whole picture.
    if (this.positions.size) this.sigma.setCustomBBox({ x: [minX, maxX], y: [minY, maxY] });
  }

  private degree(id: string): number {
    return (this.adj.incoming.get(id)?.length ?? 0) + (this.adj.outgoing.get(id)?.length ?? 0);
  }

  /** Node size grows with links, like Graphify's: the busiest file is about four times a lone one. */
  private fileSize(id: string): number {
    return 2.5 + 8 * Math.sqrt(this.degree(id) / this.maxDegree);
  }

  /** Hubs get a label at every zoom; other files show theirs on hover or when lit. */
  private isHub(id: string): boolean {
    return this.degree(id) >= this.hubDegree;
  }

  /** Rebuilds what is on screen from the files, the open folders and the layout. */
  private rebuild(): void {
    this.graph.clear();
    this.unitOfFile.clear();
    const members = new Map<string, string[]>();
    for (const n of this.data.nodes) {
      const unit = this.folding.unitOf(n.id, this.expanded);
      this.unitOfFile.set(n.id, unit);
      (members.get(unit) ?? members.set(unit, []).get(unit)!).push(n.id);
    }

    const byId = new Map(this.data.nodes.map((n) => [n.id, n]));
    const maxMembers = Math.max(1, ...[...members].filter(([u]) => isGroupId(u)).map(([, f]) => f.length));

    for (const [unit, files] of members) {
      if (!isGroupId(unit)) {
        const n = byId.get(unit)!;
        const group = this.groups.groupOf.get(unit)!;
        this.graph.addNode(unit, {
          ...this.positions.get(unit),
          label: n.sensitive ? `🔒 ${this.labelOf(unit)}` : this.labelOf(unit),
          size: this.fileSize(unit),
          group,
          hub: this.isHub(unit),
          connected: this.degree(unit) > 0,
          color: this.colorFor(group, n.sensitive),
        });
        continue;
      }
      // A folder sits at the middle of its files and takes the colour most of them have.
      let [x, y] = [0, 0];
      const tally = new Map<string, number>();
      for (const f of files) {
        const p = this.positions.get(f)!;
        x += p.x / files.length;
        y += p.y / files.length;
        bump(tally, this.groups.groupOf.get(f)!);
      }
      const group = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const tool = isToolFolder(group);
      const color = this.colorFor(group, false);
      const folder = groupFolder(unit);
      this.graph.addNode(unit, {
        x,
        y,
        type: "folder",
        // Deep folders keep their last two names on the canvas (`components/Stats/`); the panel has the full path.
        label: `${this.groupName(folder, clusterOf({ folder })).split("/").slice(-2).join("/")}/ · ${files.length}`,
        size: tool ? 4 : 5 + 13 * Math.sqrt(files.length / maxMembers),
        group,
        tool,
        connected: files.some((f) => this.degree(f) > 0),
        color: this.mix(color, tool ? 0.3 : 0.55),
        borderColor: tool ? this.mix(color, 0.5) : color,
        zIndex: tool ? 0 : 1,
      });
    }

    // Edges take their source's colour, faint like Graphify's, and fainter the more there are.
    const strength = this.graph.order > 600 ? 0.18 : this.graph.order > 150 ? 0.28 : 0.4;
    for (const e of this.data.edges) {
      const s = this.unitOfFile.get(e.source)!;
      const t = this.unitOfFile.get(e.target)!;
      if (s === t) continue;
      if (!this.graph.hasEdge(s, t)) {
        const from = this.graph.getNodeAttribute(s, "borderColor") ?? this.graph.getNodeAttribute(s, "color");
        this.graph.addDirectedEdge(s, t, { count: 1, typeOnly: e.typeOnly, size: 0.6, color: this.mix(from as string, strength) });
        continue;
      }
      const count = (this.graph.getEdgeAttribute(s, t, "count") as number) + 1;
      this.graph.mergeEdgeAttributes(s, t, {
        count,
        typeOnly: (this.graph.getEdgeAttribute(s, t, "typeOnly") as boolean) && e.typeOnly,
        size: 0.6 + Math.min(3, Math.log2(count) * 0.5),
      });
    }

    // The focus is its files, so it survives folders opening and closing. A file's panel follows it
    // into the folder it was collapsed into; an opened folder's panel closes.
    if (this.inspected && !this.graph.hasNode(this.inspected)) {
      this.inspected = isGroupId(this.inspected) ? undefined : this.unitFor(this.inspected);
    }
    if (this.hovered && !this.graph.hasNode(this.hovered)) this.hovered = undefined;
    this.relight();
    this.emit();
  }

  /**
   * Works out which units and edges stand out: the focus's links, else the hovered node's, else
   * everything inside the folder being viewed and what it connects to.
   */
  private relight(): void {
    const hover = this.hovered ? new Set(this.filesOf(this.hovered)) : undefined;
    const source = this.focusFiles ?? hover ?? this.viewing?.files;
    if (!source) {
      this.lit = undefined;
      this.sigma.refresh();
      return;
    }
    const mode = this.focusFiles || hover ? "focus" : "view";
    const lit: Lit = { mode, units: new Set(), neighbours: new Set(), edges: new Map() };
    for (const f of source) lit.units.add(this.unitFor(f)!);
    for (const e of this.data.edges) {
      if (this.filters.hideTypeOnly && e.typeOnly) continue;
      const sIn = source.has(e.source);
      const tIn = source.has(e.target);
      // Focus shows links out of the focus; viewing also shows the links inside the folder.
      if (sIn === tIn && (mode === "focus" || !sIn)) continue;
      const s = this.unitFor(e.source)!;
      const t = this.unitFor(e.target)!;
      if (s === t) continue;
      if (!sIn) lit.neighbours.add(s);
      if (!tIn) lit.neighbours.add(t);
      const key = this.graph.edge(s, t);
      if (key !== undefined) lit.edges.set(key, mode === "view" ? "view" : sIn ? "out" : "in");
    }
    this.lit = lit;
    this.sigma.refresh();
  }

  /** Opens the folders needed for a file to show on its own, and returns its unit. */
  private show(id: string): string | undefined {
    if (this.graph.hasNode(id)) return id;
    if (!this.unitOfFile.has(id)) return undefined;
    const before = this.expanded.size;
    this.folding.pathTo(id).forEach((f) => this.expanded.add(f));
    if (this.expanded.size !== before) this.rebuild();
    return id;
  }

  private unitFor(id: string): string | undefined {
    return this.graph.hasNode(id) ? id : this.unitOfFile.get(id);
  }

  private filesOf(unit: string): string[] {
    return isGroupId(unit) ? this.folding.membersOf(groupFolder(unit)) : [unit];
  }

  private emit(): void {
    this.onChange({ focus: this.focusLabel, viewing: this.viewing && `${this.viewing.folder}/`, inspected: this.inspected });
  }

  private isHidden(node: string): boolean {
    if (node === this.inspected || this.lit?.units.has(node)) return false;
    const group = this.graph.getNodeAttribute(node, "group") as string;
    if (this.hiddenGroups.has(this.slots.has(group) ? group : OTHER_KEY)) return true;
    return this.filters.hideUnconnected && !this.graph.getNodeAttribute(node, "connected");
  }

  // Drawing -----------------------------------------------------------------------------------

  /**
   * Sigma asks for labels in no useful order, and folder labels are always asked for, so long
   * names could pile up. Labels are queued here and drawn after the frame by drawLabels().
   */
  private drawLabel(...[, data]: Parameters<NodeLabelDrawingFunction>): void {
    if (!data.label) return;
    const key = (data as { key?: string }).key ?? "";
    const has = (attr: string) => this.graph.hasNode(key) && !!this.graph.getNodeAttribute(key, attr);
    const lit = key === this.inspected || this.lit?.units.has(key);
    // Like Graphify, only hubs and folders are named until something is focused.
    if (!lit && !data.forceLabel && !isGroupId(key) && !has("hub")) return;
    const rank = lit ? 3 : isGroupId(key) && !has("tool") ? 2 : has("tool") ? 0 : 1;
    this.labelQueue.push({ text: data.label, x: data.x + data.size + 4, y: data.y, rank, size: data.size });
  }

  /** Draws the queued labels, most important first (focus, then folders, then bigger nodes), skipping any that would overlap one already drawn. Each gets a halo so it reads over edges. */
  private drawLabels(): void {
    const queue = this.labelQueue.sort((a, b) => b.rank - a.rank || b.size - a.size);
    this.labelQueue = [];
    if (!queue.length) return;
    const settings = this.sigma.getSettings();
    const ctx = this.sigma.getCanvases().labels.getContext("2d");
    if (!ctx) return;
    const size = settings.labelSize;
    ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    const placed: Array<[number, number, number, number]> = [];
    const free = (b: number[]) => !placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    for (const l of queue) {
      const w = ctx.measureText(l.text).width;
      // Right of the node first; if that is taken, try its left.
      const spots = [l.x, l.x - 2 * l.size - 8 - w];
      const box = (at: number) => [at - 6, l.y - size / 2 - 3, at + w + 6, l.y + size / 2 + 3] as [number, number, number, number];
      const x = spots.find((at) => free(box(at)));
      if (x === undefined) continue;
      placed.push(box(x));
      ctx.strokeStyle = this.background();
      ctx.strokeText(l.text, x, l.y + size / 3);
      ctx.fillStyle = this.ink();
      ctx.fillText(l.text, x, l.y + size / 3);
    }
  }

  /** Hovered and highlighted nodes: a ring and a label chip in the theme's colours (Sigma's default is white on white in dark themes). */
  private drawHover(...[ctx, data, settings]: Parameters<NodeHoverDrawingFunction>): void {
    const size = settings.labelSize;
    ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    ctx.beginPath();
    ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
    ctx.strokeStyle = this.ink();
    ctx.lineWidth = 2;
    ctx.stroke();
    if (typeof data.label !== "string" || !data.label) return;
    const w = ctx.measureText(data.label).width + 10;
    const h = size + 8;
    const x = data.x + data.size + 6;
    ctx.fillStyle = this.chipColor();
    ctx.beginPath();
    ctx.roundRect(x, data.y - h / 2, w, h, 4);
    ctx.fill();
    ctx.fillStyle = this.ink();
    ctx.fillText(data.label, x + 5, data.y + size / 3);
  }

  private colorFor(group: string, sensitive: boolean): string {
    if (sensitive) return SENSITIVE_COLOR[this.theme];
    const slot = this.slots.get(group);
    return slot === undefined ? OTHER_COLOR[this.theme] : CLUSTER_COLORS[this.theme][slot];
  }

  /** A colour blended toward the background: `amount` of the colour, the rest background. */
  private mix(hex: string, amount: number): string {
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const bg = rgb(this.background());
    const c = rgb(hex);
    return `#${c.map((v, i) => Math.round(v * amount + bg[i] * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
  }

  private ink(): string {
    return this.theme === "dark" ? "#f0efec" : "#1f1f1d";
  }

  private inColor(): string {
    return this.theme === "dark" ? "#8c8b84" : "#8f8e86";
  }

  /** The page background, which in VS Code follows the user's colour theme. */
  private background(): string {
    return this.cssColor("--bg", this.theme === "dark" ? "#1a1a19" : "#fbfbf9");
  }

  private chipColor(): string {
    return this.cssColor("--input-bg", this.theme === "dark" ? "#2a2a28" : "#ffffff");
  }

  private cssColor(name: string, fallback: string): string {
    const value = getComputedStyle(this.container).getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  private faded(): string {
    return this.theme === "dark" ? "#292927" : "#ebeae5";
  }

}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** A small stable hash, so a file's starting spot is the same on every load. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
