import { describe, it, expect, beforeAll } from "vitest";
import { DEFAULT_BORDER, HSW_STANDARD, PLATE_PRESETS } from "@/lib/hsw/constants";
import { generateCells } from "@/lib/hsw/honeycomb";
import { buildTileMesh } from "@/lib/hsw/geometry";
import { buildInsertMesh, buildWallMountInsertMesh } from "@/lib/hsw/insert";
import { subdivideWall, tilesFitPlate } from "@/lib/subdivision/tiler";
import {
  placeBridgeInserts,
  placeSeamInserts,
  placeWallMountInserts,
} from "@/lib/subdivision/inserts";
import { rectangleOutline } from "@/lib/shape/polygon";
import type { HexCell, Mesh, PlateSpec } from "@/types";

function countBadEdges(mesh: Mesh): number {
  const counts = new Map<string, number>();
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const c of counts.values()) if (c !== 2) bad++;
  return bad;
}

const WALL = { width: 400, height: 350 };
const plate: PlateSpec =
  PLATE_PRESETS.find((p) => p.id === "bambu256") ?? PLATE_PRESETS[0];

describe("subdivision — 400 × 350 wall on Bambu 256", () => {
  let cells: HexCell[];
  let plan: ReturnType<typeof subdivideWall>;

  beforeAll(() => {
    const outline = rectangleOutline(WALL.width, WALL.height);
    cells = generateCells(outline, HSW_STANDARD, DEFAULT_BORDER.thickness);
    plan = subdivideWall(cells, HSW_STANDARD, plate, DEFAULT_BORDER);
  });

  it("subdivision produces at least one tile", () => {
    expect(plan.tiles.length).toBeGreaterThan(0);
  });

  it("all tiles fit the print plate (with margin)", () => {
    expect(tilesFitPlate(plan, plate)).toBe(true);
  });

  it("every cell appears in exactly one tile (full coverage)", () => {
    const seen = new Set<number>();
    for (const t of plan.tiles) for (const i of t.cellIndices) seen.add(i);
    expect(seen.size).toBe(cells.length);
  });

  it("every tile mesh is watertight AND fits within plate bbox", async () => {
    for (const t of plan.tiles) {
      const mesh = await buildTileMesh(t.outline, t.cells, HSW_STANDARD);
      expect(countBadEdges(mesh)).toBe(0);
      expect(t.bbox.width).toBeLessThanOrEqual(plate.width);
      expect(t.bbox.height).toBeLessThanOrEqual(plate.height);
    }
  });
});

describe("insert placement — 400 × 350 wall", () => {
  let cells: HexCell[];
  let plan: ReturnType<typeof subdivideWall>;

  beforeAll(() => {
    const outline = rectangleOutline(WALL.width, WALL.height);
    cells = generateCells(outline, HSW_STANDARD, DEFAULT_BORDER.thickness);
    plan = subdivideWall(cells, HSW_STANDARD, plate, DEFAULT_BORDER);
  });

  it("vertical seam inserts respect forced count", () => {
    const forced1 = placeSeamInserts(cells, plan.seamCells, plan.xSeams, plan.ySeams, HSW_STANDARD, 1);
    const forced5 = placeSeamInserts(cells, plan.seamCells, plan.xSeams, plan.ySeams, HSW_STANDARD, 5);
    // Forced-N never exceeds the seam capacity but always ≥ 1 when seams exist.
    expect(forced5.length).toBeGreaterThanOrEqual(forced1.length);
  });

  it("bridge inserts respect forced count", () => {
    const auto = placeBridgeInserts(cells, plan.ySeams, HSW_STANDARD);
    const forced5 = placeBridgeInserts(cells, plan.ySeams, HSW_STANDARD, 5);
    expect(forced5.length).toBeGreaterThanOrEqual(auto.length);
  });

  it("first sample seam clip insert is watertight", async () => {
    const inserts = placeSeamInserts(cells, plan.seamCells, plan.xSeams, plan.ySeams, HSW_STANDARD);
    if (inserts.length === 0) {
      // No seams on this plate — skip.
      return;
    }
    const mesh = await buildInsertMesh(inserts[0].centers, HSW_STANDARD);
    expect(countBadEdges(mesh)).toBe(0);
  });

  it("first sample wall-mount insert is watertight", async () => {
    const mounts = placeWallMountInserts(plan.tiles, plan.seamCells);
    if (mounts.length === 0) return;
    const mesh = await buildWallMountInsertMesh(mounts[0].centers[0], HSW_STANDARD);
    expect(countBadEdges(mesh)).toBe(0);
  });
});
