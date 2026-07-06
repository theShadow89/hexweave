import { describe, it, expect } from "vitest";
import { DEFAULT_BORDER, HSW_STANDARD, PLATE_PRESETS } from "@/lib/hsw/constants";
import { generateCells } from "@/lib/hsw/honeycomb";
import { buildTileMesh } from "@/lib/hsw/geometry";
import { subdivideWall, tilesFitPlate } from "@/lib/subdivision/tiler";
import { regularPolygon } from "@/lib/shape/fromSides";
import { polygonsFromSvg } from "@/lib/shape/fromSvg";
import { parseVerticesText } from "@/lib/shape/polygon";
import type { Mesh, Polygon } from "@/types";

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

const plate = PLATE_PRESETS.find((p) => p.id === "kobras1") ?? PLATE_PRESETS[0];

async function buildAllTiles(outline: Polygon) {
  const cells = generateCells(outline, HSW_STANDARD, DEFAULT_BORDER.thickness);
  const plan = subdivideWall(cells, HSW_STANDARD, plate, DEFAULT_BORDER, 5, outline);
  const meshes = await Promise.all(
    plan.tiles.map((t) => buildTileMesh(t.outline, t.cells, HSW_STANDARD)),
  );
  return { cells, plan, meshes };
}

describe("arbitrary shape support", () => {
  it("regular hex (80 mm) subdivides + all tiles watertight", async () => {
    const { plan, meshes } = await buildAllTiles(regularPolygon(6, 80));
    expect(tilesFitPlate(plan, plate, 5)).toBe(true);
    for (const mesh of meshes) expect(countBadEdges(mesh)).toBe(0);
  });

  it("equilateral triangle (200 mm) subdivides + all tiles watertight", async () => {
    const { plan, meshes } = await buildAllTiles(regularPolygon(3, 200));
    expect(tilesFitPlate(plan, plate, 5)).toBe(true);
    for (const mesh of meshes) expect(countBadEdges(mesh)).toBe(0);
  });

  it("L-shape (vertex list) subdivides + all tiles watertight", async () => {
    const lShape = parseVerticesText(`
      0 0
      300 0
      300 150
      150 150
      150 300
      0 300
    `);
    const { plan, meshes } = await buildAllTiles(lShape);
    expect(tilesFitPlate(plan, plate, 5)).toBe(true);
    for (const mesh of meshes) expect(countBadEdges(mesh)).toBe(0);
  });

  it("regular pentagon (120 mm) subdivides + all tiles watertight", async () => {
    const { plan, meshes } = await buildAllTiles(regularPolygon(5, 120));
    expect(tilesFitPlate(plan, plate, 5)).toBe(true);
    for (const mesh of meshes) expect(countBadEdges(mesh)).toBe(0);
  });

  // SVG parsing requires DOMParser (browser only); skip cleanly under Node.
  const svgPoly = polygonsFromSvg(
    '<svg><polygon points="0,0 250,0 250,180 80,180 80,250 0,250"/></svg>',
  );
  const runSvg = svgPoly.length > 0 ? it : it.skip;
  runSvg("SVG L-shape subdivides + all tiles watertight", async () => {
    const { plan, meshes } = await buildAllTiles(svgPoly[0]);
    expect(tilesFitPlate(plan, plate, 5)).toBe(true);
    for (const mesh of meshes) expect(countBadEdges(mesh)).toBe(0);
  });
});
