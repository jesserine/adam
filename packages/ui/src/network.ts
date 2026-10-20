import type { CodeGraph } from "@adam/core";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import {
  assignClusterSlots,
  CLUSTER_COLORS,
  clusterOf,
  OTHER_COLOR,
  SENSITIVE_COLOR,
} from "./model";

export interface NetworkFilters {
  hideUnconnected: boolean;
  hideTypeOnly: boolean;
}

export type Theme = "light" | "dark";

/** The network view: a WebGL graph of nodes (files) and edges (imports), rendered with Sigma. */
export class NetworkView {
  private readonly graph = new Graph({ multi: false, type: "directed" });
  private readonly sigma: Sigma;
  private selected: string | undefined;
  private neighbours = new Set<string>();
  private slots = new Map<string, number>();
  private filters: NetworkFilters = { hideUnconnected: false, hideTypeOnly: false };

  constructor(
    container: HTMLElement,
    private theme: Theme,
    onSelect: (id: string | undefined) => void,
  ) {
    this.sigma = new Sigma(this.graph, container, {
      defaultEdgeType: "arrow",
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 7,
      labelFont: "system-ui, -apple-system, Segoe UI, sans-serif",
      labelColor: { color: theme === "dark" ? "#f0efec" : "#1f1f1d" },
      zIndex: true,
      nodeReducer: (node, data) => {
        if (this.isHidden(node)) return { ...data, hidden: true };
        if (!this.selected) return data;
        if (node === this.selected) return { ...data, highlighted: true, zIndex: 2, forceLabel: true };
        if (this.neighbours.has(node)) return { ...data, zIndex: 1, forceLabel: true };
        return { ...data, color: this.faded(), label: "", zIndex: 0 };
      },
      edgeReducer: (edge, data) => {
        const typeOnly = this.graph.getEdgeAttribute(edge, "typeOnly") as boolean;
        if (this.filters.hideTypeOnly && typeOnly) return { ...data, hidden: true };
        if (!this.selected) return data;
        const [s, t] = this.graph.extremities(edge);
        if (s === this.selected || t === this.selected) return { ...data, color: this.ink(), size: 1.5, zIndex: 1 };
        return { ...data, hidden: true };
      },
    });

    this.sigma.on("clickNode", ({ node }) => onSelect(node));
    this.sigma.on("clickStage", () => onSelect(undefined));
    this.sigma.on("enterNode", () => (container.style.cursor = "pointer"));
    this.sigma.on("leaveNode", () => (container.style.cursor = "default"));
  }

  /** Loads a graph, keeping positions for nodes that were already on screen. */
  load(data: CodeGraph): void {
    const previous = new Map<string, { x: number; y: number }>();
    this.graph.forEachNode((id, a) => previous.set(id, { x: a.x as number, y: a.y as number }));
    this.slots = assignClusterSlots(data, this.slots);
    this.graph.clear();

    const clusters = [...new Set(data.nodes.map(clusterOf))].sort();
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    data.nodes.forEach((n, i) => {
      const cluster = clusterOf(n);
      // New nodes start on a ring per cluster, so the layout begins already grouped.
      const angle = (clusters.indexOf(cluster) / Math.max(1, clusters.length)) * 2 * Math.PI;
      const pos = previous.get(n.id) ?? {
        x: Math.cos(angle) * 100 + ((i * 7919) % 37) - 18,
        y: Math.sin(angle) * 100 + ((i * 104729) % 37) - 18,
      };
      this.graph.addNode(n.id, {
        ...pos,
        label: n.sensitive ? `🔒 ${n.name}` : n.name,
        size: 2 + Math.min(10, Math.log2(1 + (degree.get(n.id) ?? 0)) * 1.6),
        cluster,
        sensitive: n.sensitive,
        connected: (degree.get(n.id) ?? 0) > 0,
        color: this.colorFor(cluster, n.sensitive),
      });
    });
    for (const e of data.edges) {
      if (!this.graph.hasEdge(e.source, e.target)) {
        this.graph.addDirectedEdge(e.source, e.target, { size: 0.6, color: this.edgeColor(), typeOnly: e.typeOnly });
      } else if (!e.typeOnly) {
        this.graph.setEdgeAttribute(e.source, e.target, "typeOnly", false);
      }
    }

    const fresh = data.nodes.length - [...previous.keys()].filter((id) => this.graph.hasNode(id)).length;
    if (this.graph.order > 1 && fresh > 0) {
      const n = this.graph.order;
      const iterations = previous.size ? 60 : n < 500 ? 300 : n < 3000 ? 150 : 60;
      forceAtlas2.assign(this.graph, {
        iterations,
        settings: {
          ...forceAtlas2.inferSettings(this.graph),
          // LinLog pulls tightly coupled modules into visible clumps instead of one hairball.
          linLogMode: true,
          barnesHutOptimize: n > 1000,
        },
      });
    }
    if (this.selected && !this.graph.hasNode(this.selected)) this.select(undefined);
    else this.select(this.selected);
  }

  select(id: string | undefined): void {
    this.selected = id && this.graph.hasNode(id) ? id : undefined;
    this.neighbours = new Set(this.selected ? this.graph.neighbors(this.selected) : []);
    this.sigma.refresh();
  }

  focus(id: string): void {
    if (!this.graph.hasNode(id)) return;
    const pos = this.sigma.getNodeDisplayData(id);
    if (pos) void this.sigma.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.4 }, { duration: 400 });
  }

  resetCamera(): void {
    void this.sigma.getCamera().animatedReset({ duration: 300 });
  }

  setFilters(filters: NetworkFilters): void {
    this.filters = filters;
    this.sigma.refresh();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.sigma.setSetting("labelColor", { color: this.ink() });
    this.graph.forEachNode((id, a) => this.graph.setNodeAttribute(id, "color", this.colorFor(a.cluster as string, a.sensitive as boolean)));
    this.graph.forEachEdge((id) => this.graph.setEdgeAttribute(id, "color", this.edgeColor()));
    this.sigma.refresh();
  }

  /** The legend: each coloured cluster, in slot order, then "other". */
  legend(): Array<{ label: string; color: string }> {
    const items = [...this.slots.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([label, slot]) => ({ label, color: CLUSTER_COLORS[this.theme][slot] }));
    const clusters = new Set<string>();
    this.graph.forEachNode((_, a) => clusters.add(a.cluster as string));
    if ([...clusters].some((c) => !this.slots.has(c))) items.push({ label: "other folders", color: OTHER_COLOR[this.theme] });
    items.push({ label: "sensitive (masked)", color: SENSITIVE_COLOR[this.theme] });
    return items;
  }

  hasNode(id: string): boolean {
    return this.graph.hasNode(id);
  }

  destroy(): void {
    this.sigma.kill();
  }

  private isHidden(node: string): boolean {
    return this.filters.hideUnconnected && !this.graph.getNodeAttribute(node, "connected") && node !== this.selected;
  }

  private colorFor(cluster: string, sensitive: boolean): string {
    if (sensitive) return SENSITIVE_COLOR[this.theme];
    const slot = this.slots.get(cluster);
    return slot === undefined ? OTHER_COLOR[this.theme] : CLUSTER_COLORS[this.theme][slot];
  }

  private ink(): string {
    return this.theme === "dark" ? "#f0efec" : "#1f1f1d";
  }

  private faded(): string {
    return this.theme === "dark" ? "#3a3a37" : "#dcdbd5";
  }

  private edgeColor(): string {
    return this.theme === "dark" ? "#5a5a55" : "#c3c2b7";
  }
}
