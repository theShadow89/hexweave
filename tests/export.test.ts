import { describe, it, expect, beforeAll } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { DEFAULT_BORDER, HSW_STANDARD, PLATE_PRESETS } from "@/lib/hsw/constants";
import { generateCells } from "@/lib/hsw/honeycomb";
import { buildTileMesh } from "@/lib/hsw/geometry";
import { buildInsertMesh } from "@/lib/hsw/insert";
import { subdivideWall } from "@/lib/subdivision/tiler";
import { placeBridgeInserts, placeSeamInserts } from "@/lib/subdivision/inserts";
import { packBeds } from "@/lib/subdivision/packer";
import { buildThreeMf } from "@/lib/export/threemf";
import { buildAssemblyMap, assemblyMapToReadme } from "@/lib/export/assembly";
import { meshBounds3, recenterToOrigin, rotate90Z } from "@/lib/three/meshOps";
import { rectangleOutline } from "@/lib/shape/polygon";
import type { Mesh, PackedBed, PlateSpec } from "@/types";

const WALL = { width: 400, height: 350 };
const MARGIN = 5;
const plate: PlateSpec =
  PLATE_PRESETS.find((p) => p.id === "bambu256") ?? PLATE_PRESETS[0];

describe("export pipeline — 400 × 350 wall on Bambu 256", () => {
  let tileMeshes: Array<{ id: string; mesh: Mesh; w: number; h: number }>;
  let insertMeshes: Array<{ id: string; mesh: Mesh; cellCount: number }>;
  let beds: PackedBed[];
  let firstPlateArchive: Uint8Array;
  let firstPlateObjectCount: number;
  let readmeLines: number;

  beforeAll(async () => {
    const outline = rectangleOutline(WALL.width, WALL.height);
    const cells = generateCells(outline, HSW_STANDARD, DEFAULT_BORDER.thickness);
    const plan = subdivideWall(cells, HSW_STANDARD, plate, DEFAULT_BORDER, MARGIN);

    tileMeshes = await Promise.all(
      plan.tiles.map(async (t) => ({
        id: t.id,
        mesh: await buildTileMesh(t.outline, t.cells, HSW_STANDARD),
        w: t.bbox.width,
        h: t.bbox.height,
      })),
    );
    const inserts = [
      ...placeSeamInserts(cells, plan.seamCells, plan.xSeams, plan.ySeams, HSW_STANDARD),
      ...placeBridgeInserts(cells, plan.ySeams, HSW_STANDARD),
    ];
    insertMeshes = await Promise.all(
      inserts.map(async (ins) => ({
        id: ins.id,
        mesh: await buildInsertMesh(ins.centers, HSW_STANDARD),
        cellCount: ins.centers.length,
      })),
    );

    const packInputs = [
      ...tileMeshes.map((t) => ({ id: t.id, width: t.w, height: t.h })),
      ...insertMeshes.map((i) => {
        const b = meshBounds3(i.mesh);
        return { id: i.id, width: b.max[0] - b.min[0], height: b.max[1] - b.min[1] };
      }),
    ];
    beds = packBeds(packInputs, plate, MARGIN, 2);

    const meshById = new Map<string, Mesh>();
    for (const t of tileMeshes) meshById.set(t.id, t.mesh);
    for (const i of insertMeshes) meshById.set(i.id, i.mesh);

    let objectId = 1;
    const bed = beds[0];
    const objects = bed.items.map((item) => {
      let m = recenterToOrigin(meshById.get(item.id)!).mesh;
      if (item.rotated) m = recenterToOrigin(rotate90Z(m)).mesh;
      return {
        id: objectId++,
        mesh: m,
        translate: [item.x, item.y, 0] as [number, number, number],
        rotateDegZ: 0 as const,
      };
    });
    firstPlateArchive = buildThreeMf(objects);
    firstPlateObjectCount = objects.length;

    const map = buildAssemblyMap({
      requestedSize: { width: WALL.width, height: WALL.height },
      wallSize: {
        width: plan.wallOutline[2][0] - plan.wallOutline[0][0],
        height: plan.wallOutline[2][1] - plan.wallOutline[0][1],
      },
      plate,
      margin: MARGIN,
      tiles: plan.tiles,
      inserts,
      beds,
    });
    readmeLines = assemblyMapToReadme(map).split("\n").length;
  });

  it("produces at least one bin (plate) with packed items", () => {
    expect(beds.length).toBeGreaterThan(0);
    expect(beds[0].items.length).toBeGreaterThan(0);
  });

  it("no packed item extends past the bed usable area", () => {
    for (const b of beds) {
      for (const it of b.items) {
        expect(it.x + it.width).toBeLessThanOrEqual(plate.width - MARGIN + 1e-6);
        expect(it.y + it.height).toBeLessThanOrEqual(plate.height - MARGIN + 1e-6);
      }
    }
  });

  it("first plate 3MF is a valid OPC archive", () => {
    expect(firstPlateArchive.length).toBeGreaterThan(0);
    const entries = unzipSync(firstPlateArchive);
    const names = Object.keys(entries);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("3D/3dmodel.model");
  });

  it("first plate 3MF model.xml has correct object + item counts", () => {
    const entries = unzipSync(firstPlateArchive);
    const model = strFromU8(entries["3D/3dmodel.model"]);
    expect(model.startsWith("<?xml")).toBe(true);
    expect(model).toContain("<model ");
    const objectCount = (model.match(/<object /g) ?? []).length;
    const itemCount = (model.match(/<item /g) ?? []).length;
    expect(objectCount).toBe(firstPlateObjectCount);
    expect(itemCount).toBe(firstPlateObjectCount);
  });

  it("assembly README is non-trivial", () => {
    expect(readmeLines).toBeGreaterThan(10);
  });
});
