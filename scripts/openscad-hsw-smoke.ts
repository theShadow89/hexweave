import { HSW_STANDARD, DEFAULT_BORDER, DEFAULT_SNAP_STEP } from "@/lib/hsw/constants";
import { generateCells, cellsHexBbox } from "@/lib/hsw/honeycomb";
import { genTileScad } from "@/lib/openscad/scad/panel";
import { genInsertScad, genWallMountScad } from "@/lib/openscad/scad/insert";
import { DEFAULT_INSERT, DEFAULT_WALL_MOUNT } from "@/lib/hsw/insert";
import { runOpenScad } from "@/lib/openscad/openscadClient";
import { cellPitch } from "@/lib/hsw/honeycomb";
import type { Mesh, Polygon } from "@/types";

function watertight(mesh: Mesh): number {
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

function bbox(mesh: Mesh) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

async function main() {
  const outline: Polygon = [
    [0, 0], [170, 0], [170, 177], [0, 177],
  ];
  const cells = generateCells(outline, HSW_STANDARD, DEFAULT_BORDER.thickness);
  console.log(`[panel] outline 170x177, cells=${cells.length}`);

  const bb = cellsHexBbox(cells, HSW_STANDARD);
  const t = DEFAULT_BORDER.thickness;
  const panelOutline: Polygon = [
    [bb.min[0] - t, bb.min[1] - t],
    [bb.max[0] + t, bb.min[1] - t],
    [bb.max[0] + t, bb.max[1] + t],
    [bb.min[0] - t, bb.max[1] + t],
  ];

  const scadPanel = genTileScad(panelOutline, cells, HSW_STANDARD, DEFAULT_SNAP_STEP);
  console.log(`[panel] SCAD length: ${scadPanel.length} bytes`);
  const t0 = Date.now();
  const panelMesh = await runOpenScad(scadPanel);
  const t1 = Date.now();
  console.log(`[panel] render: ${t1 - t0} ms`);
  console.log(`[panel] verts=${panelMesh.positions.length / 3}, tris=${panelMesh.indices.length / 3}`);
  const pb = bbox(panelMesh);
  console.log(`[panel] bbox: x=[${pb.minX.toFixed(2)},${pb.maxX.toFixed(2)}] y=[${pb.minY.toFixed(2)},${pb.maxY.toFixed(2)}] z=[${pb.minZ.toFixed(2)},${pb.maxZ.toFixed(2)}]`);
  console.log(`[panel] watertight: ${watertight(panelMesh) === 0 ? "YES" : "NO"}`);

  // Single-cell insert
  const pitch = cellPitch(HSW_STANDARD);
  const scadInsert = genInsertScad([[0, 0]], HSW_STANDARD, DEFAULT_INSERT, ["empty"], pitch);
  console.log(`\n[insert] SCAD length: ${scadInsert.length} bytes`);
  const t2 = Date.now();
  const insertMesh = await runOpenScad(scadInsert).catch((e) => {
    console.error("insert render failed:", e.message);
    throw e;
  });
  const t3 = Date.now();
  console.log(`\n[insert empty 1-cell] render: ${t3 - t2} ms`);
  console.log(`[insert] verts=${insertMesh.positions.length / 3}, tris=${insertMesh.indices.length / 3}`);
  const ib = bbox(insertMesh);
  console.log(`[insert] bbox: x=[${ib.minX.toFixed(2)},${ib.maxX.toFixed(2)}] y=[${ib.minY.toFixed(2)},${ib.maxY.toFixed(2)}] z=[${ib.minZ.toFixed(2)},${ib.maxZ.toFixed(2)}]`);
  console.log(`[insert] watertight: ${watertight(insertMesh) === 0 ? "YES" : "NO"}`);

  // Wall mount countersunk M3
  const scadMount = genWallMountScad([0, 0], HSW_STANDARD, DEFAULT_WALL_MOUNT);
  const t4 = Date.now();
  const mountMesh = await runOpenScad(scadMount);
  const t5 = Date.now();
  console.log(`\n[wallmount csk-M3] render: ${t5 - t4} ms`);
  console.log(`[mount] verts=${mountMesh.positions.length / 3}, tris=${mountMesh.indices.length / 3}`);
  const mb = bbox(mountMesh);
  console.log(`[mount] bbox: x=[${mb.minX.toFixed(2)},${mb.maxX.toFixed(2)}] y=[${mb.minY.toFixed(2)},${mb.maxY.toFixed(2)}] z=[${mb.minZ.toFixed(2)},${mb.maxZ.toFixed(2)}]`);
  console.log(`[mount] watertight: ${watertight(mountMesh) === 0 ? "YES" : "NO"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
