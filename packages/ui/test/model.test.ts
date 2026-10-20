import { describe, expect, it } from "vitest";
import type { CodeGraph, GraphNode } from "@adam/core";
import { assignClusterSlots, buildTree, clusterOf, ROOT_CLUSTER } from "../src/model";

const graphOf = (ids: string[]): CodeGraph =>
  ({
    nodes: ids.map((id) => ({ id, folder: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "" }) as GraphNode),
    edges: [],
  }) as unknown as CodeGraph;

describe("clusterOf", () => {
  it("groups by module folder, looking inside container folders", () => {
    expect(clusterOf({ folder: "" })).toBe(ROOT_CLUSTER);
    expect(clusterOf({ folder: "scripts" })).toBe("scripts");
    expect(clusterOf({ folder: "src/lib/db" })).toBe("src/lib");
    expect(clusterOf({ folder: "packages/core/src" })).toBe("packages/core");
    expect(clusterOf({ folder: "src" })).toBe("src");
  });
});

describe("assignClusterSlots", () => {
  it("gives the biggest clusters a slot and keeps slots stable across reloads", () => {
    const first = assignClusterSlots(graphOf(["a/1", "a/2", "a/3", "b/1", "b/2", "c/1"]));
    expect(first.get("a")).toBe(0);
    expect(first.get("b")).toBe(1);
    expect(first.get("c")).toBe(2);

    // "c" grows past "a": it keeps its colour instead of being repainted by rank.
    const second = assignClusterSlots(graphOf(["a/1", "c/1", "c/2", "c/3", "c/4", "d/1"]), first);
    expect(second.get("a")).toBe(0);
    expect(second.get("c")).toBe(2);
    expect(second.has("b")).toBe(false);
    expect(second.get("d")).toBe(1);
  });

  it("folds clusters beyond the palette into other", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}/x`);
    expect(assignClusterSlots(graphOf(ids)).size).toBe(7);
  });
});

describe("buildTree", () => {
  it("builds folders first, then files, sorted by name", () => {
    const tree = buildTree([{ id: "README.md" }, { id: "src/b.ts" }, { id: "src/a.ts" }, { id: "src/lib/db.ts" }]);
    expect(tree.map((e) => e.name)).toEqual(["src", "README.md"]);
    expect(tree[0].children!.map((e) => e.name)).toEqual(["lib", "a.ts", "b.ts"]);
    expect(tree[0].children![0].children![0].path).toBe("src/lib/db.ts");
  });
});
