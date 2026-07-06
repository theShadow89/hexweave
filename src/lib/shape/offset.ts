import type { Polygon, Vec2 } from "@/types";
import { isCCW, signedArea } from "@/lib/shape/polygon";

interface Edge {
  a: Vec2;
  b: Vec2;
}

function lineLineIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const x1 = p1[0], y1 = p1[1];
  const x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1];
  const x4 = p4[0], y4 = p4[1];
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/**
 * Offset a simple closed polygon outward by `d` mm using mitered joints.
 * Works for convex and reasonably concave shapes; very pointy convex corners
 * may produce a long miter. Returns an empty polygon when `poly` is invalid.
 */
export function offsetPolygonOutward(poly: Polygon, d: number): Polygon {
  if (d === 0 || poly.length < 3) return poly;
  if (Math.abs(signedArea(poly)) < 1e-6) return poly;
  const ccw: Polygon = isCCW(poly) ? poly : [...poly].reverse();
  const n = ccw.length;

  const shifted: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const p1 = ccw[i];
    const p2 = ccw[(i + 1) % n];
    const ex = p2[0] - p1[0];
    const ey = p2[1] - p1[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ux = ex / len;
    const uy = ey / len;
    // CCW polygon: outward normal is to the right of edge direction.
    const nx = uy;
    const ny = -ux;
    shifted.push({
      a: [p1[0] + nx * d, p1[1] + ny * d],
      b: [p2[0] + nx * d, p2[1] + ny * d],
    });
  }
  const m = shifted.length;
  if (m < 3) return poly;

  const result: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const prev = shifted[(i + m - 1) % m];
    const curr = shifted[i];
    const inter = lineLineIntersection(prev.a, prev.b, curr.a, curr.b);
    result.push(inter ?? curr.a);
  }
  // If two consecutive output vertices collapse, drop the duplicate.
  const dedup: Vec2[] = [];
  for (let i = 0; i < result.length; i++) {
    const v = result[i];
    const prev = dedup[dedup.length - 1];
    if (!prev || Math.hypot(v[0] - prev[0], v[1] - prev[1]) > 1e-6) {
      dedup.push(v);
    }
  }
  return dedup;
}
