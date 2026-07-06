import type { InsertSpec, PackedBed, PlateSpec, TileSpec, Vec2 } from "@/types";

export interface AssemblyMap {
  wall: {
    requestedWidth: number;
    requestedHeight: number;
    actualWidth: number;
    actualHeight: number;
  };
  plate: { id: string; label: string; width: number; height: number; margin: number };
  tiles: Array<{
    id: string;
    width: number;
    height: number;
    position: { x: number; y: number }; // world bottom-left in the wall
    cells: number;
  }>;
  inserts: Array<{ id: string; cellCenters: Vec2[] }>;
  beds: Array<{
    index: number;
    items: Array<{ id: string; x: number; y: number; width: number; height: number; rotated: boolean }>;
  }>;
}

export function buildAssemblyMap(args: {
  requestedSize: { width: number; height: number };
  wallSize: { width: number; height: number };
  plate: PlateSpec;
  margin: number;
  tiles: TileSpec[];
  inserts: InsertSpec[];
  beds: PackedBed[];
}): AssemblyMap {
  return {
    wall: {
      requestedWidth: args.requestedSize.width,
      requestedHeight: args.requestedSize.height,
      actualWidth: args.wallSize.width,
      actualHeight: args.wallSize.height,
    },
    plate: {
      id: args.plate.id,
      label: args.plate.label,
      width: args.plate.width,
      height: args.plate.height,
      margin: args.margin,
    },
    tiles: args.tiles.map((t) => ({
      id: t.id,
      width: t.bbox.width,
      height: t.bbox.height,
      position: { x: t.bbox.min[0], y: t.bbox.min[1] },
      cells: t.cells.length,
    })),
    inserts: args.inserts.map((i) => ({ id: i.id, cellCenters: [...i.centers] })),
    beds: args.beds.map((b) => ({ index: b.index, items: b.items })),
  };
}

export function assemblyMapToReadme(map: AssemblyMap): string {
  const lines: string[] = [];
  lines.push("Hexweave export");
  lines.push("");
  lines.push(
    `Wall (requested): ${map.wall.requestedWidth} x ${map.wall.requestedHeight} mm`,
  );
  lines.push(
    `Wall (actual)   : ${map.wall.actualWidth.toFixed(1)} x ${map.wall.actualHeight.toFixed(1)} mm`,
  );
  lines.push(
    `Plate           : ${map.plate.label} (${map.plate.width}x${map.plate.height} mm, margin ${map.plate.margin} mm)`,
  );
  lines.push(`Tiles           : ${map.tiles.length}`);
  lines.push(`Inserts         : ${map.inserts.length}`);
  lines.push(`Print plates    : ${map.beds.length}`);
  lines.push("");
  lines.push("Tile layout in the wall (origin = lower-left, mm):");
  for (const t of map.tiles) {
    lines.push(
      `  ${t.id}  ${t.width.toFixed(1)}x${t.height.toFixed(1)} at (${t.position.x.toFixed(1)}, ${t.position.y.toFixed(1)})  cells=${t.cells}`,
    );
  }
  lines.push("");
  lines.push("Print plates (each STL/3MF file holds the pieces for one plate):");
  for (const bed of map.beds) {
    lines.push(`  plate ${bed.index + 1}:`);
    for (const it of bed.items) {
      lines.push(
        `    ${it.id}  ${it.width.toFixed(1)}x${it.height.toFixed(1)} at (${it.x.toFixed(1)}, ${it.y.toFixed(1)})${it.rotated ? "  [rot 90°]" : ""}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Assembly: every internal seam is a butt joint; cells on a seam are half-cells",
  );
  lines.push(
    "that recombine into a full hex when the adjacent tile is placed. Each insert spans",
  );
  lines.push(
    "1+ adjacent seam cells (id suffix _xN = N cells, filename matches the first cell).",
  );
  lines.push("Press the flange-down face into the recombined hexes to lock the tile pair.");
  return lines.join("\n");
}
