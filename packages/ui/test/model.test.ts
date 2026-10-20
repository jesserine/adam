import { describe, expect, it } from "vitest";
import type { CodeGraph, GraphNode } from "@adam/core";
import { assignClusterSlots, buildTree, clusterOf, fileLabels, Folding, groupFolder, groupId, ROOT_CLUSTER } from "../src/model";

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

describe("Folding", () => {
  const files = [
    "package.json",
    "apps/web/src/main.tsx",
    "apps/web/src/lib/a.ts",
    "apps/web/src/lib/b.ts",
    "apps/web/src/routes/x/page.tsx",
    "apps/web/src/routes/y.tsx",
    "packages/db/index.ts",
    "packages/db/schema.ts",
    "packages/solo/only.ts",
  ];
  const folding = new Folding(graphOf(files).nodes);

  it("shows each cluster as one folder when nothing is open", () => {
    const units = new Set(files.map((f) => folding.unitOf(f, new Set())));
    expect([...units].map((u) => (u.startsWith("\u0000") ? groupFolder(u) : u)).sort()).toEqual([
      "apps/web",
      "package.json",
      "packages/db",
      "packages/solo/only.ts",
    ]);
  });

  it("skips folders that are their parent's only entry or hold one file", () => {
    // apps/web holds only src/, so opening apps/web shows src's children straight away.
    const open = new Set(["apps/web"]);
    expect(folding.unitOf("apps/web/src/main.tsx", open)).toBe("apps/web/src/main.tsx");
    expect(folding.unitOf("apps/web/src/lib/a.ts", open)).toBe(groupId("apps/web/src/lib"));
    // routes/x holds one file, so it never folds on its own.
    expect(folding.unitOf("apps/web/src/routes/x/page.tsx", new Set(["apps/web", "apps/web/src/routes"]))).toBe(
      "apps/web/src/routes/x/page.tsx",
    );
    expect(folding.pathTo("apps/web/src/routes/x/page.tsx")).toEqual(["apps/web", "apps/web/src/routes"]);
  });

  it("finds the open folder a unit sits in", () => {
    expect(folding.parentOf("apps/web/src/lib/a.ts")).toBe("apps/web/src/lib");
    expect(folding.parentOf(groupId("apps/web/src/lib"))).toBe("apps/web");
    expect(folding.parentOf(groupId("apps/web"))).toBeUndefined();
    expect(folding.parentOf("package.json")).toBeUndefined();
    expect(folding.membersOf("apps/web/src/routes")).toHaveLength(2);
  });
});

describe("fileLabels", () => {
  it("adds just enough of the path to tell files with the same name apart", () => {
    const labels = fileLabels(["apps/web/src/index.ts", "packages/ui/src/index.ts", "packages/ui/index.ts", "src/app.ts", "index.ts"]);
    expect(labels.get("src/app.ts")).toBe("app.ts");
    expect(labels.get("apps/web/src/index.ts")).toBe("web/…/index.ts");
    expect(labels.get("packages/ui/src/index.ts")).toBe("ui/…/index.ts");
    expect(labels.get("packages/ui/index.ts")).toBe("ui/index.ts");
    expect(labels.get("index.ts")).toBe("index.ts");
  });
});
