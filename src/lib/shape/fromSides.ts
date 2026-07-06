import type { Polygon, Vec2 } from "@/types";

export interface Segment {
  /** Edge length in mm. */
  length: number;
  /** Turning angle at the END of this edge (CCW positive, degrees). For a
   * convex closed polygon, every turn equals the exterior angle and the sum
   * over all edges is 360°. */
  turnDeg: number;
}

/**
 * Build a polygon by walking N segments. The polygon starts at the origin
 * heading +X; after each segment the current direction is rotated by
 * `turnDeg`. The result is normalised so its bbox.min sits at the origin.
 *
 * For a regular N-gon with side L, pass N segments of length L and turn
 * 360 / N degrees each (e.g. triangle 120°, square 90°, hexagon 60°).
 */
export function polygonFromSides(segments: Segment[]): Polygon {
  if (segments.length < 3) return [];
  const pts: Vec2[] = [[0, 0]];
  let x = 0;
  let y = 0;
  let angle = 0; // radians, heading +X
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    x += Math.cos(angle) * seg.length;
    y += Math.sin(angle) * seg.length;
    angle += (seg.turnDeg * Math.PI) / 180;
    if (i < segments.length - 1) pts.push([x, y]);
  }
  // Drop a closing vertex coincident with the start.
  return normalisePolygon(pts);
}

/** Move polygon so its lower-left bbox corner sits at the origin. */
export function normalisePolygon(poly: Polygon): Polygon {
  if (poly.length === 0) return poly;
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  return poly.map(([x, y]) => [x - minX, y - minY] as Vec2);
}

/** Convenience: closed regular N-gon with given side length. */
export function regularPolygon(sides: number, sideLength: number): Polygon {
  const turn = 360 / sides;
  const segments: Segment[] = Array.from({ length: sides }, () => ({
    length: sideLength,
    turnDeg: turn,
  }));
  return polygonFromSides(segments);
}
