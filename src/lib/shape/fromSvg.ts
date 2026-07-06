import type { Polygon, Vec2 } from "@/types";
import { normalisePolygon } from "@/lib/shape/fromSides";

/**
 * Extract one or more closed polygons from an SVG document. Supported sources:
 *   <polygon points="..."/>
 *   <polyline points="..."/>          (closed implicitly)
 *   <path d="M x y L x y ... Z"/>     (M/L/H/V/Z, absolute and relative)
 * Curves (C, S, Q, T, A) are not supported; samples points only at command
 * endpoints. SVG Y axis is flipped so the result matches the mm-up convention.
 */
export function polygonsFromSvg(svgText: string): Polygon[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) return [];
  const polygons: Polygon[] = [];

  for (const el of Array.from(doc.querySelectorAll("polygon, polyline"))) {
    const pts = parsePointList(el.getAttribute("points") ?? "");
    if (pts.length >= 3) polygons.push(pts);
  }
  for (const el of Array.from(doc.querySelectorAll("path"))) {
    const pts = parsePathData(el.getAttribute("d") ?? "");
    if (pts.length >= 3) polygons.push(pts);
  }

  // Flip Y (SVG Y goes down) and translate to non-negative origin.
  return polygons
    .map((p) => p.map(([x, y]) => [x, -y] as Vec2))
    .map(normalisePolygon)
    .filter((p) => p.length >= 3);
}

function parsePointList(s: string): Polygon {
  const tokens = s
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    out.push([tokens[i], tokens[i + 1]]);
  }
  return out;
}

function parsePathData(d: string): Polygon {
  // Tokenise: single-letter commands or numbers (incl. scientific notation).
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const pts: Vec2[] = [];
  let cmd = "";
  let i = 0;
  let cx = 0;
  let cy = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") return pts;
      continue;
    }
    switch (cmd) {
      case "M":
      case "L": {
        cx = num();
        cy = num();
        pts.push([cx, cy]);
        if (cmd === "M") cmd = "L"; // subsequent pairs treated as L
        break;
      }
      case "m":
      case "l": {
        cx += num();
        cy += num();
        pts.push([cx, cy]);
        if (cmd === "m") cmd = "l";
        break;
      }
      case "H": {
        cx = num();
        pts.push([cx, cy]);
        break;
      }
      case "h": {
        cx += num();
        pts.push([cx, cy]);
        break;
      }
      case "V": {
        cy = num();
        pts.push([cx, cy]);
        break;
      }
      case "v": {
        cy += num();
        pts.push([cx, cy]);
        break;
      }
      default:
        // Unsupported command; bail to avoid mis-parsing.
        return pts;
    }
  }
  return pts;
}
