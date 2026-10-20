import type { CodeGraph, GraphEdge } from "@adam/core";
import { createNodeBorderProgram } from "@sigma/node-border";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import Sigma from "sigma";
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
import {
  adjacency,
  assignClusterSlots,
  CLUSTER_COLORS,
  clusterOf,
  fileLabels,
  Folding,
  groupFolder,
  isGroupId,
  isToolFolder,
  sharedPrefix,
  OTHER_COLOR,
  SENSITIVE_COLOR,
} from "./model";

export interface NetworkFilters {
  hideUnconnected: boolean;
  hideTypeOnly: boolean;
}

export type Theme = "light" | "dark";

/** What the view is showing: the focus (by label), whose links stay on screen, and the unit whose panel is open. */
export interface NetworkState {
  focus: string | undefined;
  inspected: string | undefined;
}

/** A unit's links to other units, counted in file-level imports. */
export interface UnitLink {
  unit: string;
  label: string;
  count: number;
}

/** Above this many files, the network opens with every cluster collapsed. */
const COLLAPSE_ABOVE = 150;

interface Lit {
  units: Set<string>;
  neighbours: Set<string>;
  /** On-screen edges that touch the lit files, and which way they point. */
  edges: Map<string, "out" | "in">;
}

/**
 * The network view: a WebGL graph of nodes (files) and edges (imports), rendered with Sigma.
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
  /** Width of the laid-out graph, to turn node sizes (pixels) into layout units. */
  private extent = 1;
  private labels = new Map<string, string>();
  /** A dotted prefix most clusters share (`CPBuild.`), left off folder labels on the canvas. */
  private prefix = "";
  private unitOfFile = new Map<string, string>();
  private slots = new Map<string, number>();
  private filters: NetworkFilters = { hideUnconnected: false, hideTypeOnly: false };

  private focusFiles: Set<string> | undefined;
  private focusLabel: string | undefined;
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
      defaultEdgeType: "line",
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.6,
      labelGridCellSize: 120,
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
        const [s, t] = this.graph.extremities(edge);
        const strong = this.inspected !== undefined && !lit.units.has(this.inspected) && (s === this.inspected || t === this.inspected);
        return {
          ...data,
          type: "arrow",
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
    this.sigma.on("clickStage", () => this.clearFocus());
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
    this.slots = assignClusterSlots(data, this.slots);
    if (firstLoad && data.nodes.length <= COLLAPSE_ABOVE) this.expanded = new Set(this.folding.folders());
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

  /** Opens a collapsed folder, or closes the folder a node sits in. */
  toggle(unit: string): void {
    if (isGroupId(unit)) this.expanded.add(groupFolder(unit));
    else {
      const parent = this.folding.parentOf(unit);
      if (parent === undefined) return;
      for (const f of [...this.expanded]) if (f === parent || f.startsWith(`${parent}/`)) this.expanded.delete(f);
    }
    this.rebuild();
  }

  /** Whether a unit can be collapsed into a folder above it. */
  canCollapse(unit: string): boolean {
    return this.folding.parentOf(unit) !== undefined;
  }

  expandAll(): void {
    this.expanded = new Set(this.folding.folders());
    this.rebuild();
    this.fit();
  }

  collapseAll(): void {
    this.expanded.clear();
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
    const camera = this.sigma.getCamera();
    if (!Number.isFinite(minX)) return void camera.animatedReset({ duration: animate ? 300 : 0 });
    const state = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio: Math.min(3, Math.max(0.1, Math.max(maxX - minX, maxY - minY) * 1.25)) };
    if (animate) void camera.animate(state, { duration: 300 });
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

  /** The legend: each coloured cluster, in slot order, then "other". */
  legend(): Array<{ label: string; color: string }> {
    const items = [...this.slots.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([label, slot]) => ({ label, color: CLUSTER_COLORS[this.theme][slot] }));
    if (this.data.nodes.some((n) => !this.slots.has(clusterOf(n)))) items.push({ label: "other folders", color: OTHER_COLOR[this.theme] });
    items.push({ label: "sensitive (masked)", color: SENSITIVE_COLOR[this.theme] });
    return items;
  }

  hasNode(id: string): boolean {
    return this.unitOfFile.has(id) || this.graph.hasNode(id);
  }

  destroy(): void {
    this.sigma.kill();
  }

  // Building the view --------------------------------------------------------------------------

  /** One force layout over every file; folders sit at the middle of their files. */
  private layout(): void {
    const g = new Graph({ multi: false, type: "directed" });
    const clusters = [...new Set(this.data.nodes.map(clusterOf))].sort();
    this.data.nodes.forEach((n, i) => {
      // New nodes start on a ring per cluster, so the layout begins already grouped.
      const angle = (clusters.indexOf(clusterOf(n)) / Math.max(1, clusters.length)) * 2 * Math.PI;
      g.addNode(n.id, this.positions.get(n.id) ?? {
        x: Math.cos(angle) * 100 + ((i * 7919) % 37) - 18,
        y: Math.sin(angle) * 100 + ((i * 104729) % 37) - 18,
      });
    });
    for (const e of this.data.edges) if (!g.hasEdge(e.source, e.target)) g.addDirectedEdge(e.source, e.target);

    const fresh = this.data.nodes.filter((n) => !this.positions.has(n.id)).length;
    if (g.order > 1 && fresh > 0) {
      const n = g.order;
      const iterations = this.positions.size ? 60 : n < 500 ? 300 : n < 3000 ? 150 : 60;
      forceAtlas2.assign(g, {
        iterations,
        settings: {
          ...forceAtlas2.inferSettings(g),
          // LinLog pulls tightly coupled modules into visible clumps instead of one hairball.
          linLogMode: true,
          barnesHutOptimize: n > 1000,
        },
      });
    }
    this.positions = new Map();
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    g.forEachNode((id, a) => {
      const p = { x: a.x as number, y: a.y as number };
      this.positions.set(id, p);
      [minX, maxX, minY, maxY] = [Math.min(minX, p.x), Math.max(maxX, p.x), Math.min(minY, p.y), Math.max(maxY, p.y)];
    });
    // Fixed framing: opening or closing a folder must not rescale the whole picture.
    if (g.order) this.sigma.setCustomBBox({ x: [minX, maxX], y: [minY, maxY] });
    this.extent = Math.max(1, maxX - minX, maxY - minY);
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
    const degree = (id: string) => (this.adj.incoming.get(id)?.length ?? 0) + (this.adj.outgoing.get(id)?.length ?? 0);
    const groups = [...members.keys()].some(isGroupId);

    for (const [unit, files] of members) {
      if (!isGroupId(unit)) {
        const n = byId.get(unit)!;
        const cluster = clusterOf(n);
        this.graph.addNode(unit, {
          ...this.positions.get(unit),
          label: n.sensitive ? `🔒 ${this.labelOf(unit)}` : this.labelOf(unit),
          size: 2 + Math.min(10, Math.log2(1 + degree(unit)) * 1.6),
          cluster,
          connected: degree(unit) > 0,
          color: this.colorFor(cluster, n.sensitive),
        });
        continue;
      }
      let x = 0;
      let y = 0;
      for (const f of files) {
        x += this.positions.get(f)!.x;
        y += this.positions.get(f)!.y;
      }
      const cluster = clusterOf(byId.get(files[0])!);
      const color = this.colorFor(cluster, false);
      const tool = isToolFolder(cluster);
      // Folders are the landmarks, so they always ask for a label; drawLabels() decides which fit.
      this.graph.addNode(unit, {
        x: x / files.length,
        y: y / files.length,
        type: "folder",
        label: `${this.groupName(groupFolder(unit), cluster)}/ · ${files.length}`,
        size: tool ? 5 : Math.min(26, 6 + Math.sqrt(files.length) * 1.6),
        cluster,
        tool,
        connected: files.some((f) => degree(f) > 0),
        color: this.mix(color, tool ? 0.15 : 0.35),
        borderColor: tool ? this.mix(color, 0.5) : color,
        forceLabel: true,
        zIndex: tool ? 0 : 1,
      });
    }

    // Folders sit at the middle of their files, which can land them on top of each other or of
    // other nodes. A light overlap pass pushes them apart without redoing the layout.
    // Folders count with their label (drawn to the right), so folder names do not collide either.
    if (groups && this.graph.order > 1) {
      const px = this.extent / Math.max(300, Math.min(this.container.clientWidth, this.container.clientHeight) || 800);
      const reach = (id: string) => (isGroupId(id) ? (4 + (this.graph.getNodeAttribute(id, "label") as string).length * 6.5) / 2 : 0);
      noverlap.assign(this.graph, {
        maxIterations: 150,
        inputReducer: (id, a) => ({ x: a.x + reach(id) * px, y: a.y, size: (a.size! + reach(id)) * px }),
        outputReducer: (id, a) => ({ x: a.x - reach(id) * px, y: a.y }),
        settings: { margin: 8 * px, ratio: 1, speed: 3 },
      });
    }

    for (const e of this.data.edges) {
      const s = this.unitOfFile.get(e.source)!;
      const t = this.unitOfFile.get(e.target)!;
      if (s === t) continue;
      if (!this.graph.hasEdge(s, t)) {
        this.graph.addDirectedEdge(s, t, { count: 1, typeOnly: e.typeOnly, size: 0.5, color: this.edgeColor() });
        continue;
      }
      const count = (this.graph.getEdgeAttribute(s, t, "count") as number) + 1;
      this.graph.mergeEdgeAttributes(s, t, {
        count,
        typeOnly: (this.graph.getEdgeAttribute(s, t, "typeOnly") as boolean) && e.typeOnly,
        size: 0.5 + Math.min(4, Math.log2(count) * 0.6),
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

  /** Works out which units and edges stand out: the focus's, or the hovered node's while nothing is focused. */
  private relight(): void {
    const source = this.focusFiles ?? (this.hovered ? new Set(this.filesOf(this.hovered)) : undefined);
    if (!source) {
      this.lit = undefined;
      this.sigma.refresh();
      return;
    }
    const lit: Lit = { units: new Set(), neighbours: new Set(), edges: new Map() };
    for (const f of source) lit.units.add(this.unitFor(f)!);
    const visit = (e: GraphEdge, dir: "out" | "in") => {
      if (this.filters.hideTypeOnly && e.typeOnly) return;
      const other = dir === "out" ? e.target : e.source;
      if (source.has(other)) return;
      const here = this.unitFor(dir === "out" ? e.source : e.target)!;
      const there = this.unitFor(other)!;
      if (here === there) return;
      if (!lit.units.has(there)) lit.neighbours.add(there);
      const key = dir === "out" ? this.graph.edge(here, there) : this.graph.edge(there, here);
      if (key !== undefined) lit.edges.set(key, dir);
    };
    for (const f of source) {
      for (const e of this.adj.outgoing.get(f) ?? []) visit(e, "out");
      for (const e of this.adj.incoming.get(f) ?? []) visit(e, "in");
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
    this.onChange({ focus: this.focusLabel, inspected: this.inspected });
  }

  private isHidden(node: string): boolean {
    if (!this.filters.hideUnconnected || this.graph.getNodeAttribute(node, "connected")) return false;
    return node !== this.inspected && !this.lit?.units.has(node);
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
    const rank = key === this.inspected || this.lit?.units.has(key) ? 3 : isGroupId(key) && !has("tool") ? 2 : has("tool") ? 0 : 1;
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
      const left = l.x - 2 * l.size - 8 - w;
      const x = [l.x, left].find((at) => free([at - 2, l.y - size / 2 - 3, at + w + 2, l.y + size / 2 + 3]));
      if (x === undefined) continue;
      placed.push([x - 2, l.y - size / 2 - 3, x + w + 2, l.y + size / 2 + 3]);
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

  private colorFor(cluster: string, sensitive: boolean): string {
    if (sensitive) return SENSITIVE_COLOR[this.theme];
    const slot = this.slots.get(cluster);
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

  /** Edges are pre-blended with the background: Sigma adds translucent colours, which brightens them. */
  private edgeColor(): string {
    return this.mix(this.theme === "dark" ? "#a6a59c" : "#6e6d64", 0.3);
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
