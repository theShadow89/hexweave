import { describe, it, expect } from "vitest";
import { DEFAULT_BORDER, HSW_STANDARD } from "@/lib/hsw/constants";
import { generateCells } from "@/lib/hsw/honeycomb";
import { buildPanelMesh } from "@/lib/hsw/geometry";
import { rectangleOutline } from "@/lib/shape/polygon";
import type { HswParams, Mesh } from "@/types";

// Original wall-honeycomb-part.stl: 170.317 x 177 x 8 mm. With HSW_STANDARD's
// 3.6 mm inter-cell wall (2 × 1.8 mm half-walls) the reference footprint holds
// 42 cells — matching the measured original.
const TARGET = { width: 170.317, height: 177, depth: 8, holes: 42 };

function meshBounds(mesh: Mesh) {
  const p = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  return { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
}

/** A closed manifold has every undirected edge shared by exactly two triangles. */
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

async function buildReferenceTile(orientation: HswParams["orientation"]) {
  const params: HswParams = { ...HSW_STANDARD, orientation };
  const outline = rectangleOutline(TARGET.width, TARGET.height);
  const cells = generateCells(outline, params, DEFAULT_BORDER.thickness);
  const mesh = await buildPanelMesh(outline, params, DEFAULT_BORDER);
  return { params, outline, cells, mesh };
}

describe("panel geometry — reference tile 170.3 × 177 mm", () => {
  it("pointy-top produces a watertight mesh", async () => {
    const { mesh } = await buildReferenceTile("pointy");
    expect(countBadEdges(mesh)).toBe(0);
  });

  it("flat-top produces a watertight mesh", async () => {
    const { mesh } = await buildReferenceTile("flat");
    expect(countBadEdges(mesh)).toBe(0);
  });

  it("closest orientation yields the target hole count (= 42)", async () => {
    const pointy = await buildReferenceTile("pointy");
    const flat = await buildReferenceTile("flat");
    const pointyDelta = Math.abs(pointy.cells.length - TARGET.holes);
    const flatDelta = Math.abs(flat.cells.length - TARGET.holes);
    const winner = pointyDelta <= flatDelta ? pointy : flat;
    expect(winner.cells.length).toBe(TARGET.holes);
  });

  it("mesh depth matches HSW standard (8 mm)", async () => {
    const { mesh } = await buildReferenceTile("flat");
    const b = meshBounds(mesh);
    expect(b.z).toBeCloseTo(TARGET.depth, 3);
  });
});

describe("panel geometry — borderless mode", () => {
  it("200×200 mm borderless panel is watertight", async () => {
    const outline = rectangleOutline(200, 200);
    const mesh = await buildPanelMesh(outline, HSW_STANDARD, {
      enabled: false,
      thickness: 0,
    });
    expect(countBadEdges(mesh)).toBe(0);
  });
});
