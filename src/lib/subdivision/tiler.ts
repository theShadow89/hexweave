import polygonClipping from "polygon-clipping";
import type {
  BorderOptions,
  HexCell,
  HswParams,
  PlateSpec,
  Polygon,
  TileSpec,
  Vec2,
} from "@/types";
import {
  cellCircumradius,
  cellPitch,
  cellsHexBbox,
  holePolygon,
} from "@/lib/hsw/honeycomb";

export interface TilingPlan {
  /** Full wall outline rectangle including the border. */
  wallOutline: Polygon;
  /** Per-tile spec ready to extrude. */
  tiles: TileSpecV2[];
  /** Cells that fall on a seam, useful for placing inserts on the joint. */
  seamCells: HexCell[];
  /** World X positions of internal vertical seams (cut centres of bisected columns). */
  xSeams: number[];
  /** World Y positions of internal horizontal seams (used to place bridge inserts). */
  ySeams: number[];
}

export interface TileSpecV2 extends TileSpec {
  /** Hole polygons (some half- or quarter-cells when the cell sits on a seam). */
  holes: Polygon[];
  /** Which sides of this tile are wall-external (have border) vs internal seams. */
  externalSides: { left: boolean; right: boolean; top: boolean; bottom: boolean };
}

/**
 * Plan vertical and horizontal seams that keep every tile within the plate.
 * Vertical seams are placed at integer column indices so the cells at
 * that column are bisected exactly through their centre by x = col * 1.5*R.
 * Horizontal seams are at row indices: y = row * Fcell bisects the cells of
 * even-parity columns in that row, and lines up with the flat edges of the
 * odd-parity neighbours, so adjacent tiles butt cleanly.
 */
function planSeams1D(
  minIdx: number,
  maxIdx: number,
  cellSpan: number,
  wallEdgeLow: number,
  wallEdgeHigh: number,
  plateExtent: number,
): number[] {
  const wallExtent = wallEdgeHigh - wallEdgeLow;
  if (wallExtent <= plateExtent) return [];

  // First tile spans from wallEdgeLow to seam_idx * cellSpan; we need
  //   seam_idx * cellSpan - wallEdgeLow <= plateExtent.
  const seams: number[] = [];
  const maxFirst = Math.floor((plateExtent + wallEdgeLow) / cellSpan);
  const maxInternalStep = Math.max(1, Math.floor(plateExtent / cellSpan));
  let seam = Math.min(maxFirst, maxIdx);
  if (seam <= minIdx) seam = minIdx + 1;
  seams.push(seam);

  while (true) {
    const remainingWidth = wallEdgeHigh - seam * cellSpan;
    if (remainingWidth <= plateExtent) break;
    const next = Math.min(seam + maxInternalStep, maxIdx);
    if (next <= seam) break;
    seams.push(next);
    seam = next;
  }
  return seams;
}

/** Inclusive cell column range derived from current cell set. */
function indexRange(cells: HexCell[], axis: "col" | "row"): { min: number; max: number } {
  let mn = Infinity;
  let mx = -Infinity;
  for (const c of cells) {
    const v = c[axis];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { min: mn, max: mx };
}

type GeoPoly = [number, number][][];
const asGeo = (p: Polygon): GeoPoly => [p.map(([x, y]) => [x, y] as [number, number])];

function openRing(ring: [number, number][]): Polygon {
  if (ring.length < 4) return ring.map(([x, y]) => [x, y] as Vec2);
  const last = ring.length - 1;
  const closed = ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
  const open = closed ? ring.slice(0, last) : ring;
  return open.map(([x, y]) => [x, y] as Vec2);
}

function rectPolygon(minX: number, minY: number, maxX: number, maxY: number): Polygon {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/**
 * Subdivide the wall so the assembled tiles reproduce the original silhouette
 * exactly: every internal seam is a clean butt joint with no extra border, and
 * cells that sit on a seam get split into half-cells that recombine when the
 * adjacent tile snaps in beside.
 */
export function subdivideWall(
  cells: HexCell[],
  params: HswParams,
  plate: PlateSpec,
  border: BorderOptions,
  margin = 0,
  customOutline?: Polygon,
): TilingPlan {
  if (cells.length === 0) {
    return { wallOutline: rectPolygon(0, 0, 0, 0), tiles: [], seamCells: [], xSeams: [], ySeams: [] };
  }
  const usableW = Math.max(0, plate.width - 2 * margin);
  const usableH = Math.max(0, plate.height - 2 * margin);
  const R = cellCircumradius(params);
  const Fcell = cellPitch(params);
  const thickness = border.enabled ? border.thickness : 0;
  const cellsBbox = cellsHexBbox(cells, params);

  // Wall outline: user polygon when supplied, otherwise cellsHexBbox + thickness
  // (the snug rectangle that gives uniform border for the rectangle preset).
  const wallOutline: Polygon =
    customOutline && customOutline.length >= 3
      ? customOutline
      : rectPolygon(
          cellsBbox.min[0] - thickness,
          cellsBbox.min[1] - thickness,
          cellsBbox.max[0] + thickness,
          cellsBbox.max[1] + thickness,
        );

  let wallMinX = Infinity, wallMinY = Infinity, wallMaxX = -Infinity, wallMaxY = -Infinity;
  for (const [x, y] of wallOutline) {
    if (x < wallMinX) wallMinX = x;
    if (y < wallMinY) wallMinY = y;
    if (x > wallMaxX) wallMaxX = x;
    if (y > wallMaxY) wallMaxY = y;
  }
  const isRectWall = isAxisAlignedRect(wallOutline);

  const cols = indexRange(cells, "col");
  const rows = indexRange(cells, "row");
  const colSpan = 1.5 * R;
  const rowSpan = Fcell;
  const xSeamCols = planSeams1D(cols.min, cols.max, colSpan, wallMinX, wallMaxX, usableW);
  const ySeamRows = planSeams1D(rows.min, rows.max, rowSpan, wallMinY, wallMaxY, usableH);
  const xSeams = xSeamCols.map((c) => c * colSpan);
  const ySeams = ySeamRows.map((r) => r * rowSpan);
  const xBreaks = [wallMinX, ...xSeams, wallMaxX];
  const yBreaks = [wallMinY, ...ySeams, wallMaxY];

  const tiles: TileSpecV2[] = [];
  const seamCellSet = new Map<string, HexCell>();
  let tileIndex = 0;
  for (let tj = 0; tj < yBreaks.length - 1; tj++) {
    for (let ti = 0; ti < xBreaks.length - 1; ti++) {
      const gridRect = rectPolygon(xBreaks[ti], yBreaks[tj], xBreaks[ti + 1], yBreaks[tj + 1]);
      const regions: Polygon[] = isRectWall
        ? [gridRect]
        : intersectPolygons(gridRect, wallOutline);
      for (const region of regions) {
        if (region.length < 3 || polygonAbsArea(region) < 1) continue;

        const tileCells: HexCell[] = [];
        const tileCellIndices: number[] = [];
        const fullHoles: Polygon[] = [];
        const seamCutHoles: Polygon[] = [];
        for (let ci = 0; ci < cells.length; ci++) {
          const cell = cells[ci];
          if (
            cell.center[0] + R < xBreaks[ti] ||
            cell.center[0] - R > xBreaks[ti + 1] ||
            cell.center[1] + R < yBreaks[tj] ||
            cell.center[1] - R > yBreaks[tj + 1]
          ) {
            continue;
          }
          // Border-clipped cells use their pre-clipped polygon as a full hole
          // (they never enter seamCellSet — their split is at the wall outer
          // border, not at an internal seam, so they can't host an insert).
          // If a border-clipped cell ALSO crosses an internal seam, we carve
          // the per-tile fragment from the outline (like a normal seamCutHole)
          // instead of treating it as an interior hole — a double-clipped
          // hole polygon is brittle, but a boolean difference against the
          // tile outline is robust under the OpenSCAD CSG pipeline.
          const hole = cell.clipped ?? holePolygon(cell.center, params);
          const cls = classifyCellInRegion(hole, region);
          if (cls === "outside") continue;
          if (cell.clipped) {
            if (cls === "inside") {
              tileCells.push(cell);
              tileCellIndices.push(ci);
              fullHoles.push(hole);
            } else {
              const parts = intersectPolygons(hole, region);
              if (parts.length > 0) {
                tileCells.push(cell);
                tileCellIndices.push(ci);
                for (const part of parts) {
                  if (polygonAbsArea(part) > 1e-3) seamCutHoles.push(part);
                }
              }
            }
          } else {
            tileCells.push(cell);
            tileCellIndices.push(ci);
            if (cls === "inside") {
              fullHoles.push(hole);
            } else {
              seamCutHoles.push(hole);
              seamCellSet.set(`${cell.col}_${cell.row}`, cell);
            }
          }
        }
        if (tileCells.length === 0) continue;

        let outlinePoly: Polygon = region;
        if (seamCutHoles.length > 0) {
          const diff = polygonClipping.difference(asGeo(region), ...seamCutHoles.map(asGeo));
          if (diff.length > 0 && diff[0].length > 0) {
            outlinePoly = openRing(diff[0][0]);
          }
        }

        const regionBbox = polygonBbox(region);
        tiles.push({
          id: `tile_${ti}_${tj}_${tileIndex++}`,
          cellIndices: tileCellIndices,
          cells: tileCells,
          outline: outlinePoly,
          bbox: {
            min: regionBbox.min,
            max: regionBbox.max,
            width: regionBbox.max[0] - regionBbox.min[0],
            height: regionBbox.max[1] - regionBbox.min[1],
          },
          holes: fullHoles,
          externalSides: {
            left: ti === 0,
            right: ti === xBreaks.length - 2,
            bottom: tj === 0,
            top: tj === yBreaks.length - 2,
          },
        });
      }
    }
  }
  return { wallOutline, tiles, seamCells: [...seamCellSet.values()], xSeams, ySeams };
}

function intersectPolygons(a: Polygon, b: Polygon): Polygon[] {
  const result = polygonClipping.intersection(asGeo(a), asGeo(b));
  const out: Polygon[] = [];
  for (const poly of result) {
    if (poly.length === 0) continue;
    out.push(openRing(poly[0]));
  }
  return out;
}

function isAxisAlignedRect(poly: Polygon): boolean {
  if (poly.length !== 4) return false;
  return poly.every((_, i) => {
    const a = poly[i];
    const b = poly[(i + 1) % 4];
    return Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6;
  });
}

function polygonAbsArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

function polygonBbox(poly: Polygon): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

function classifyCellInRegion(
  hole: Polygon,
  region: Polygon,
): "outside" | "inside" | "split" {
  const result = polygonClipping.intersection(asGeo(hole), asGeo(region));
  if (result.length === 0 || result[0].length === 0) return "outside";
  const ring = result[0][0];
  const last = ring.length - 1;
  const closed =
    last > 0 && ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
  const ringLen = closed ? last : ring.length;
  return ringLen === hole.length ? "inside" : "split";
}

export function tilesFitPlate(plan: TilingPlan, plate: PlateSpec, margin = 0): boolean {
  const usableW = plate.width - 2 * margin;
  const usableH = plate.height - 2 * margin;
  return plan.tiles.every((t) => t.bbox.width <= usableW && t.bbox.height <= usableH);
}
