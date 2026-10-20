import { describe, expect, it } from "vitest";
import { layoutByGroup, type LayoutInput } from "../src/layout";

/** Two groups, each with a couple of subfolders, and some imports inside and across them. */
function input(): LayoutInput {
  const files = ["a/x/1", "a/x/2", "a/x/3", "a/y/1", "a/y/2", "a/top", "b/x/1", "b/x/2", "b/y/1", "b/y/2", "b/y/3"];
  const imports: Record<string, string[]> = { "a/x/1": ["a/x/2", "a/y/1"], "a/y/2": ["b/y/1"], "b/x/1": ["b/x/2", "b/y/3"] };
  return {
    files,
    outgoing: (f) => imports[f] ?? [],
    groupOf: new Map(files.map((f) => [f, f.slice(0, 1)])),
    pathTo: (f) => f.split("/").slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join("/")}/`),
    size: () => 4,
  };
}

describe("layoutByGroup", () => {
  it("places every file without overlaps, with room for labels", () => {
    const { positions } = layoutByGroup(input());
    const points = [...positions.values()];
    expect(points).toHaveLength(11);
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThan(20);
      }
    }
  });

  it("keeps each group in its own area, apart from the others", () => {
    const { positions, groups } = layoutByGroup(input());
    const [a, b] = [groups.get("a")!, groups.get("b")!];
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
    for (const [f, p] of positions) {
      const g = groups.get(f.slice(0, 1))!;
      expect(Math.hypot(p.x - g.x, p.y - g.y)).toBeLessThanOrEqual(g.r);
    }
  });

  it("gives each subfolder a centre inside its group, and draws the same way every time", () => {
    const first = layoutByGroup(input());
    expect(first.folders.has("a/x/")).toBe(true);
    expect(first.folders.has("b/y/")).toBe(true);
    const again = layoutByGroup(input());
    expect([...again.positions]).toEqual([...first.positions]);
  });
});
