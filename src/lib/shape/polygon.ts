import polygonClipping from "polygon-clipping";
import type { Polygon, Vec2 } from "@/types";

export function polygonBounds(poly: Polygon): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

/** Signed area; positive when the polygon is counter-clockwise. */
export function signedArea(poly: Polygon): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function isCCW(poly: Polygon): boolean {
  return signedArea(poly) > 0;
}

export function ensureWinding(poly: Polygon, ccw: boolean): Polygon {
  return isCCW(poly) === ccw ? poly : [...poly].reverse();
}

/** Ray-casting point-in-polygon test (boundary treated as inside-ish). */
export function pointInPolygon(p: Vec2, poly: Polygon): boolean {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function rectangleOutline(width: number, height: number): Polygon {
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
}

/** Parse a textarea where each non-empty line holds "x y" or "x, y" in mm. */
export function parseVerticesText(text: string): Polygon {
  const out: Vec2[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const tokens = line.split(/[\s,;]+/).map(Number);
    if (tokens.length < 2 || !Number.isFinite(tokens[0]) || !Number.isFinite(tokens[1])) continue;
    out.push([tokens[0], tokens[1]]);
  }
  return out;
}

/**
 * Union of a set of simple polygons. Returns the outer rings of every connected
 * component; interior holes (rare for a contiguous honeycomb) are dropped since
 * the panel uses them as a separate cap-hole list.
 */
export function unionPolygons(polys: Polygon[]): Polygon[] {
  if (polys.length === 0) return [];
  const asGeo = polys.map((p) => [p.map(([x, y]) => [x, y] as [number, number])]);
  const [first, ...rest] = asGeo;
  const result = polygonClipping.union(first, ...rest);
  const out: Polygon[] = [];
  for (const poly of result) {
    if (poly.length === 0) continue;
    const ring = poly[0];
    // polygon-clipping returns closed rings; drop the trailing duplicate so
    // downstream consumers don't see a zero-length edge.
    const last = ring.length - 1;
    const closed =
      last > 0 && ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
    const open = closed ? ring.slice(0, last) : ring;
    out.push(open.map(([x, y]) => [x, y] as Vec2));
  }
  return out;
}
