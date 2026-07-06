import type { HexCell, HswParams, Polygon, Vec2 } from "@/types";
import { pointInPolygon, polygonBounds } from "@/lib/shape/polygon";
import { offsetPolygonOutward } from "@/lib/shape/offset";

const SQRT3 = Math.sqrt(3);

/** Centre-to-centre flat-to-flat pitch of the lattice (mm). */
export function cellPitch(params: HswParams): number {
  return params.cellInnerWidth + params.wallThickness;
}

/** Circumradius (centre to corner) of the lattice cell hexagon (mm). */
export function cellCircumradius(params: HswParams): number {
  return cellPitch(params) / SQRT3;
}

/** Circumradius of the empty hexagonal hole (mm). */
function holeCircumradius(params: HswParams): number {
  return params.cellInnerWidth / SQRT3;
}

/** Vertices of a hexagon centred at `c`, in CCW order. */
export function hexagon(c: Vec2, circumradius: number, orientation: HswParams["orientation"]): Polygon {
  const startDeg = orientation === "pointy" ? 90 : 0;
  const pts: Vec2[] = [];
  for (let i = 0; i < 6; i++) {
    const a = ((startDeg + i * 60) * Math.PI) / 180;
    pts.push([c[0] + circumradius * Math.cos(a), c[1] + circumradius * Math.sin(a)]);
  }
  return pts;
}

/** The hole polygon for a given cell centre. */
export function holePolygon(center: Vec2, params: HswParams): Polygon {
  return hexagon(center, holeCircumradius(params), params.orientation);
}

/**
 * Hex hole with a custom flat-to-flat dimension at the same centre. Used to
 * generate the rear (wider) section and the chamfer slabs of the snap-step
 * groove. Orientation matches the cell lattice so the rear hex aligns with
 * the front hex.
 */
export function holePolygonAtFlat(
  center: Vec2,
  flatToFlat: number,
  orientation: HswParams["orientation"],
): Polygon {
  return hexagon(center, flatToFlat / SQRT3, orientation);
}

export interface GenerateCellsOptions {
  /**
   * When defined and < 1, include cells whose hexagon is clipped by the wall
   * outer border (computed as `outline` shrunk inward by `borderClearance`).
   * A cell is kept if its clipped polygon has at least this fraction of the
   * full hex area. Set to 0 to keep every sliver; 1 (or undefined) keeps the
   * original "full hexes only" behaviour.
   */
  partialMinAreaRatio?: number;
}

const HEX_AREA_K = (3 * Math.sqrt(3)) / 2; // area of a regular hexagon with circumradius R is K*R^2.

function polygonAreaAbs(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

/**
 * Sutherland-Hodgman clipping of a convex polygon against an axis-aligned
 * rectangle. Deterministic, no library quirks, produces clean outputs with no
 * duplicate vertices for our hex-vs-rect intersections.
 */
function clipPolygonToRect(
  poly: Polygon,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
): Polygon {
  const clipAgainst = (
    src: Polygon,
    isInside: (p: Vec2) => boolean,
    intersect: (a: Vec2, b: Vec2) => Vec2,
  ): Polygon => {
    if (src.length === 0) return [];
    const out: Polygon = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[(i + 1) % src.length];
      const ai = isInside(a);
      const bi = isInside(b);
      if (ai && bi) out.push(b);
      else if (ai && !bi) out.push(intersect(a, b));
      else if (!ai && bi) {
        out.push(intersect(a, b));
        out.push(b);
      }
    }
    return out;
  };

  let r: Polygon = poly;
  r = clipAgainst(
    r,
    (p) => p[1] >= yMin,
    (a, b) => {
      const t = (yMin - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), yMin];
    },
  );
  r = clipAgainst(
    r,
    (p) => p[1] <= yMax,
    (a, b) => {
      const t = (yMax - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), yMax];
    },
  );
  r = clipAgainst(
    r,
    (p) => p[0] >= xMin,
    (a, b) => {
      const t = (xMin - a[0]) / (b[0] - a[0]);
      return [xMin, a[1] + t * (b[1] - a[1])];
    },
  );
  r = clipAgainst(
    r,
    (p) => p[0] <= xMax,
    (a, b) => {
      const t = (xMax - a[0]) / (b[0] - a[0]);
      return [xMax, a[1] + t * (b[1] - a[1])];
    },
  );
  // Drop consecutive duplicate vertices (can appear when an edge of the input
  // lies exactly on a clip line).
  const out: Polygon = [];
  const tol = 1e-7;
  for (const v of r) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev[0] - v[0]) > tol || Math.abs(prev[1] - v[1]) > tol) {
      out.push([v[0], v[1]] as Vec2);
    }
  }
  if (out.length >= 2) {
    const first = out[0];
    const lastOut = out[out.length - 1];
    if (Math.abs(first[0] - lastOut[0]) < tol && Math.abs(first[1] - lastOut[1]) < tol) {
      out.pop();
    }
  }
  return out;
}

function isAxisAlignedRect(poly: Polygon): boolean {
  if (poly.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) return false;
  }
  return true;
}

/**
 * Generate every hole whose hexagon fits fully inside the outline (default), or
 * include partial cells clipped by the outer border when `partialMinAreaRatio`
 * is set. Lattice math differs by orientation:
 *   pointy: rows step in X by pitch, alternate rows offset by pitch/2; row
 *           vertical step is 1.5*R.
 *   flat:   columns step in Y by pitch, alternate columns offset by pitch/2;
 *           column horizontal step is 1.5*R.
 */
export function generateCells(
  outline: Polygon,
  params: HswParams,
  borderClearance: number,
  options: GenerateCellsOptions = {},
): HexCell[] {
  const pitch = cellPitch(params);
  const R = cellCircumradius(params);
  // The HOLE is smaller than the cell outer (cell outer = inner + wallThickness/2
  // around). When clipping a partial cell to the inner-border area, we clip the
  // HOLE, not the cell outer — the wall between adjacent holes must remain.
  const holeR = holeCircumradius(params);
  const { min, max } = polygonBounds(outline);
  const cells: HexCell[] = [];

  const allowPartial =
    options.partialMinAreaRatio !== undefined && options.partialMinAreaRatio < 1;
  const minAreaRatio = options.partialMinAreaRatio ?? 1;
  // Inner outline: area where cells must live (outline shrunk by clearance).
  // Partial mode only supports axis-aligned rectangular inner outlines for now
  // (the user's bordered-rect case); arbitrary inner shapes fall back to the
  // original full-cells-only behaviour.
  let innerRect:
    | { xMin: number; yMin: number; xMax: number; yMax: number }
    | null = null;
  if (allowPartial) {
    const inner = offsetPolygonOutward(outline, -borderClearance);
    if (isAxisAlignedRect(inner)) {
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
      for (const [x, y] of inner) {
        if (x < xMin) xMin = x;
        if (y < yMin) yMin = y;
        if (x > xMax) xMax = x;
        if (y > yMax) yMax = y;
      }
      innerRect = { xMin, yMin, xMax, yMax };
    }
  }
  const fullHoleArea = HEX_AREA_K * holeR * holeR;

  const tryPush = (center: Vec2, col: number, row: number) => {
    if (!innerRect) {
      // Original behaviour: include only if expanded hex fits entirely inside.
      const guardHex = hexagon(center, R + borderClearance, params.orientation);
      for (const v of guardHex) if (!pointInPolygon(v, outline)) return;
      cells.push({ center, col, row });
      return;
    }
    // Pull the clip rectangle in by a sub-printable per-cell epsilon. Cells
    // along the same wall edge would otherwise produce colinear edges at the
    // inner boundary, which historically tripped earcut's hole-bridging step
    // and currently keeps CGAL CSG from collapsing tangent surfaces. The hash
    // by (col, row) breaks the alignment without changing visible geometry
    // (steps of ~1e-3 mm — far below print resolution).
    const cellHash = ((col * 73856093) ^ (row * 19349663)) & 0xff;
    const eps = 5e-4 + cellHash * 5e-6;
    const xMin = innerRect.xMin + eps;
    const yMin = innerRect.yMin + eps;
    const xMax = innerRect.xMax - eps;
    const yMax = innerRect.yMax - eps;
    // Clip the INNER hex (the panel hole). Adjacent holes are separated by the
    // panel wall (wallThickness) so their clipped versions never share an edge.
    const hex = hexagon(center, holeR, params.orientation);
    // Fast-path: hex bbox entirely outside inner rect → skip.
    let hMinX = Infinity, hMinY = Infinity, hMaxX = -Infinity, hMaxY = -Infinity;
    for (const [x, y] of hex) {
      if (x < hMinX) hMinX = x;
      if (y < hMinY) hMinY = y;
      if (x > hMaxX) hMaxX = x;
      if (y > hMaxY) hMaxY = y;
    }
    if (hMaxX <= xMin || hMinX >= xMax || hMaxY <= yMin || hMinY >= yMax) return;
    // Fast-path: hex bbox entirely inside inner rect → full cell, no clipping.
    if (hMinX >= xMin && hMaxX <= xMax && hMinY >= yMin && hMaxY <= yMax) {
      cells.push({ center, col, row });
      return;
    }
    const clipped = clipPolygonToRect(hex, xMin, yMin, xMax, yMax);
    if (clipped.length < 3) return;
    const area = polygonAreaAbs(clipped);
    const ratio = area / fullHoleArea;
    if (ratio < minAreaRatio) return;
    if (ratio >= 0.9995) {
      cells.push({ center, col, row });
    } else {
      cells.push({ center, col, row, clipped });
    }
  };

  if (params.orientation === "pointy") {
    const rowStep = 1.5 * R;
    const nRows = Math.ceil((max[1] - min[1]) / rowStep) + 2;
    const nCols = Math.ceil((max[0] - min[0]) / pitch) + 2;
    for (let row = -1; row < nRows; row++) {
      const y = min[1] + row * rowStep;
      const xOffset = (row & 1) === 0 ? 0 : pitch / 2;
      for (let col = -1; col < nCols; col++) {
        const x = min[0] + xOffset + col * pitch;
        tryPush([x, y], col, row);
      }
    }
  } else {
    const colStep = 1.5 * R;
    const nCols = Math.ceil((max[0] - min[0]) / colStep) + 2;
    const nRows = Math.ceil((max[1] - min[1]) / pitch) + 2;
    for (let col = -1; col < nCols; col++) {
      const x = min[0] + col * colStep;
      const yOffset = (col & 1) === 0 ? 0 : pitch / 2;
      for (let row = -1; row < nRows; row++) {
        const y = min[1] + yOffset + row * pitch;
        tryPush([x, y], col, row);
      }
    }
  }
  return cells;
}

/** Outer hexagon of a cell, used to compose the panel outline in borderless mode. */
export function cellOuterPolygon(center: Vec2, params: HswParams): Polygon {
  return hexagon(center, cellCircumradius(params), params.orientation);
}

/** Axis-aligned bbox of every cell's outer hexagon. */
export function cellsHexBbox(
  cells: HexCell[],
  params: HswParams,
): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    const hex = cellOuterPolygon(cell.center, params);
    for (const [x, y] of hex) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

/**
 * Trace the boundary of the union of `hexagons` by counting edges. An edge
 * shared by two hexagons is internal; the rest form the outline.
 * Returns a single closed loop assuming the hexagons are contiguous.
 */
export function traceOutlineFromHexes(hexagons: Polygon[]): Polygon {
  const KEY_SCALE = 1000; // 1 µm precision is plenty (cells are ~20 mm).
  const key = (v: Vec2) => `${Math.round(v[0] * KEY_SCALE)}_${Math.round(v[1] * KEY_SCALE)}`;
  const edgeKey = (a: Vec2, b: Vec2) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const edges = new Map<string, { count: number; a: Vec2; b: Vec2 }>();
  for (const hex of hexagons) {
    for (let i = 0; i < hex.length; i++) {
      const a = hex[i];
      const b = hex[(i + 1) % hex.length];
      const k = edgeKey(a, b);
      const cur = edges.get(k);
      if (cur) cur.count++;
      else edges.set(k, { count: 1, a, b });
    }
  }
  const boundary = [...edges.values()].filter((e) => e.count === 1);
  if (boundary.length === 0) return [];

  const adj = new Map<string, typeof boundary>();
  for (const e of boundary) {
    for (const v of [e.a, e.b]) {
      const vk = key(v);
      const list = adj.get(vk) ?? [];
      list.push(e);
      adj.set(vk, list);
    }
  }
  const start = boundary[0];
  const visited = new Set<string>([edgeKey(start.a, start.b)]);
  const loop: Vec2[] = [start.a];
  let current = start.b;
  const startKey = key(start.a);
  while (key(current) !== startKey) {
    loop.push(current);
    const opts = adj.get(key(current)) ?? [];
    const next = opts.find((e) => !visited.has(edgeKey(e.a, e.b)));
    if (!next) break;
    visited.add(edgeKey(next.a, next.b));
    current = key(next.a) === key(current) ? next.b : next.a;
  }
  return loop;
}

/** Convenience wrapper for cells. */
export function traceBorderlessOutline(cells: HexCell[], params: HswParams): Polygon {
  return traceOutlineFromHexes(cells.map((c) => cellOuterPolygon(c.center, params)));
}

/** Axial (col, row) deltas for the 6 lattice neighbours of a cell. */
export function neighbourDeltas(
  cell: { col: number; row: number },
  orientation: HswParams["orientation"],
): Array<readonly [number, number]> {
  if (orientation === "flat") {
    // Columns step in X, alternate columns are offset in Y.
    const odd = (cell.col & 1) === 1;
    return [
      [0, -1],
      [0, 1],
      [-1, odd ? 0 : -1],
      [-1, odd ? 1 : 0],
      [1, odd ? 0 : -1],
      [1, odd ? 1 : 0],
    ];
  }
  // Pointy-top: rows step in Y, alternate rows are offset in X.
  const odd = (cell.row & 1) === 1;
  return [
    [-1, 0],
    [1, 0],
    [odd ? 0 : -1, -1],
    [odd ? 1 : 0, -1],
    [odd ? 0 : -1, 1],
    [odd ? 1 : 0, 1],
  ];
}
