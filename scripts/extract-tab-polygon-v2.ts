/**
 * Extract the EXACT 2D outline of the snap-fit tab from the original
 * RostaP Insert-countersunk.stl, preserving FULL outline detail — including
 * the rear shelf/step that the v1 extractor truncated.
 *
 * Root cause of v1 truncation:
 *   v1 set Z_TAB_MAX = 9.10 mm. The tab outline at y=0 actually extends to
 *   z ≈ 9.6 mm via a long segment (10.2798, 8.7405) -> (10.0649, 9.1702)
 *   -> (9.85, 9.6). This is the snap-catch shelf the user identified.
 *   v1 also resampled to 30 arc-length-uniform points, which smoothed away
 *   the kink at (10.0649, 9.1702).
 *
 * Approach:
 *   1. Load binary STL.
 *   2. XY-center mesh on its bbox.
 *   3. Rotate mesh by -30° around Z so a flat hex face is at +X.
 *   4. PROPER PLANE SLICE y=0: per-edge crossing test, two crossings per
 *      triangle = one segment.
 *   5. Filter to z ∈ [7.0, 10.0] (covers the FULL tab extent including the
 *      shelf tail to z≈9.6) and x ∈ [9.0, 11.5] (body-outer side).
 *   6. Build a node/edge graph (spatial-hash dedupe).
 *   7. Walk the closed polyline starting at the leftmost-bottom tab node.
 *   8. Convert to (protrusion, z_local). Trim to the contiguous segment
 *      where protrusion > 0 (the actual tab profile, including the shelf
 *      tail). NO RESAMPLING — every mesh vertex on the slice is preserved.
 *   9. Cap with (-EMBED, 0) and (-EMBED, totalZ).
 *
 * Output:
 *   - JSON dump of the polygon + stats.
 *   - In-place edit of barbed_tab POLY_RAW / POLY_PEAK in library.ts.
 *
 * Run: npx tsx scripts/extract-tab-polygon-v2.ts [path/to/Insert-countersunk.stl]
 *
 * If no STL path is passed the script falls back to $HSW_INSERT_STL, then to
 * a conventional Downloads location. All other paths (library.ts, JSON dump)
 * are resolved relative to the repo root so the script works in a checkout at
 * any location.
 */

import fs from "node:fs";
import path from "node:path";
import { parseStl } from "../src/lib/openscad/stlParser";

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_STL_PATH = path.join(
  process.env.HOME ?? "",
  "Downloads",
  "honeycomb-storage-wall-model_files",
  "Parts for attaching honeycombs to the wall",
  "Insert-countersunk.stl",
);
const STL_PATH =
  process.argv[2] ?? process.env.HSW_INSERT_STL ?? DEFAULT_STL_PATH;
const LIBRARY_TS_PATH = path.join(
  REPO_ROOT,
  "src/lib/openscad/scad/library.ts",
);
const JSON_OUT_PATH = path.join(
  process.env.SCRATCHPAD ?? REPO_ROOT,
  "tab-polygon-v2.json",
);

const APOTHEM = 9.895;
const EDGE_THETA_DEG = 30;
const X_BBOX_MIN = 9.0;
const X_BBOX_MAX = 11.5;
const Z_BBOX_MIN = 7.0;
const Z_BBOX_MAX = 10.0;
const EMBED = 0.05;
const FLANGE_HEIGHT = 2.5;
const PT_EPS = 1e-4;

// ---------- load + center + rotate ----------
const bytes = new Uint8Array(fs.readFileSync(STL_PATH));
const mesh = parseStl(bytes);
const P = mesh.positions;
const I = mesh.indices;
const triCount = I.length / 3;

let xmin = Infinity,
  xmax = -Infinity,
  ymin = Infinity,
  ymax = -Infinity;
for (let i = 0; i < P.length; i += 3) {
  if (P[i] < xmin) xmin = P[i];
  if (P[i] > xmax) xmax = P[i];
  if (P[i + 1] < ymin) ymin = P[i + 1];
  if (P[i + 1] > ymax) ymax = P[i + 1];
}
const cx = (xmin + xmax) / 2;
const cy = (ymin + ymax) / 2;

const a = (-EDGE_THETA_DEG * Math.PI) / 180;
const ca = Math.cos(a);
const sa = Math.sin(a);
const nVerts = P.length / 3;
const Vx = new Float64Array(nVerts);
const Vy = new Float64Array(nVerts);
const Vz = new Float64Array(nVerts);
for (let i = 0, v = 0; i < P.length; i += 3, v++) {
  const dx = P[i] - cx;
  const dy = P[i + 1] - cy;
  Vx[v] = ca * dx - sa * dy;
  Vy[v] = sa * dx + ca * dy;
  Vz[v] = P[i + 2];
}

// ---------- plane slice y=0 (proper per-edge crossings) ----------
type Pt = { x: number; z: number };
type Seg = { a: Pt; b: Pt };

function sliceAtY0(): Seg[] {
  const segs: Seg[] = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = I[t * 3];
    const i1 = I[t * 3 + 1];
    const i2 = I[t * 3 + 2];
    const y0 = Vy[i0];
    const y1 = Vy[i1];
    const y2 = Vy[i2];
    const cuts: Pt[] = [];
    addEdgeCut(cuts, y0, y1, i0, i1);
    addEdgeCut(cuts, y1, y2, i1, i2);
    addEdgeCut(cuts, y2, y0, i2, i0);

    // Dedupe vertex-on-plane crossings reported twice (from adjacent edges)
    const u: Pt[] = [];
    for (const c of cuts) {
      if (
        u.some(
          (q) => Math.abs(q.x - c.x) < PT_EPS && Math.abs(q.z - c.z) < PT_EPS,
        )
      )
        continue;
      u.push(c);
    }
    if (u.length !== 2) continue;
    segs.push({ a: u[0], b: u[1] });
  }
  return segs;
}

function addEdgeCut(out: Pt[], ya: number, yb: number, ia: number, ib: number) {
  const saS = Math.sign(ya);
  const sbS = Math.sign(yb);
  if (saS === sbS && saS !== 0) return;
  if (saS === 0 && sbS === 0) return;
  let u: number;
  if (saS === 0) u = 0;
  else if (sbS === 0) u = 1;
  else {
    const denom = ya - yb;
    if (Math.abs(denom) < 1e-15) return;
    u = ya / denom;
    if (u < -1e-9 || u > 1 + 1e-9) return;
  }
  out.push({
    x: Vx[ia] + (Vx[ib] - Vx[ia]) * u,
    z: Vz[ia] + (Vz[ib] - Vz[ia]) * u,
  });
}

// ---------- filter to tab region ----------
function inTabBbox(p: Pt): boolean {
  return (
    p.z >= Z_BBOX_MIN &&
    p.z <= Z_BBOX_MAX &&
    p.x >= X_BBOX_MIN &&
    p.x <= X_BBOX_MAX
  );
}

const allSegs = sliceAtY0();
const segs = allSegs.filter((s) => inTabBbox(s.a) && inTabBbox(s.b));

if (segs.length === 0) {
  console.error("No segments in tab region.");
  process.exit(1);
}

// ---------- build graph + walk polyline ----------
type Node = Pt & { segIdx: number[] };
const nodes: Node[] = [];
const segEnds: Array<[number, number]> = [];
const bucketSize = 1e-3;
const buckets = new Map<string, number[]>();

function nodeOf(p: Pt): number {
  const bx = Math.round(p.x / bucketSize);
  const bz = Math.round(p.z / bucketSize);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const key = `${bx + dx}_${bz + dz}`;
      const cand = buckets.get(key);
      if (!cand) continue;
      for (const idx of cand) {
        if (
          Math.abs(nodes[idx].x - p.x) < PT_EPS &&
          Math.abs(nodes[idx].z - p.z) < PT_EPS
        )
          return idx;
      }
    }
  }
  const idx = nodes.length;
  nodes.push({ x: p.x, z: p.z, segIdx: [] });
  const key = `${bx}_${bz}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key)!.push(idx);
  return idx;
}

for (let s = 0; s < segs.length; s++) {
  const ia = nodeOf(segs[s].a);
  const ib = nodeOf(segs[s].b);
  if (ia === ib) continue;
  segEnds.push([ia, ib]);
  nodes[ia].segIdx.push(segEnds.length - 1);
  nodes[ib].segIdx.push(segEnds.length - 1);
}

// The TAB outline is the connected component containing the apothem-touching
// node at the lowest z (= tab base on body face side). Identify it by:
//   1. Find all nodes with x ≈ APOTHEM (within 0.05 mm) — these are body-face
//      touch points.
//   2. Among those, find the pair with smallest z and largest z — these are
//      the tab base feet.
//   3. Walk from the smallest-z body-face node along edges, choosing
//      neighbours that progress through the tab profile, until we reach the
//      largest-z body-face node.

function isOnBodyFace(n: Pt): boolean {
  return Math.abs(n.x - APOTHEM) < 0.06;
}

// Collect body-face nodes in the tab region.
const bodyFaceNodes = nodes
  .map((n, i) => ({ i, n }))
  .filter(({ n }) => isOnBodyFace(n));
if (bodyFaceNodes.length < 2) {
  console.error(
    `Need at least 2 body-face nodes near apothem; got ${bodyFaceNodes.length}.`,
  );
  process.exit(2);
}
// Sort by z ascending
bodyFaceNodes.sort((a, b) => a.n.z - b.n.z);
const startIdx = bodyFaceNodes[0].i;
const endIdx = bodyFaceNodes[bodyFaceNodes.length - 1].i;

// BFS / shortest-edge walk along the outline. Because the slice is a clean
// polyline (each node has degree 2 within the tab outline, except at junctions
// where the tab outline meets the body face), a greedy walk preferring
// segments that PROGRESS toward higher prot then back works.

// Simpler: depth-first search for any path from startIdx to endIdx that uses
// each node at most once and stays inside the tab bbox.
function dfsPath(): number[] | null {
  const stack: Array<{ node: number; path: number[]; usedSegs: Set<number> }> = [
    { node: startIdx, path: [startIdx], usedSegs: new Set() },
  ];
  while (stack.length > 0) {
    const { node, path, usedSegs } = stack.pop()!;
    if (node === endIdx && path.length > 2) {
      return path;
    }
    for (const s of nodes[node].segIdx) {
      if (usedSegs.has(s)) continue;
      const [ia, ib] = segEnds[s];
      const other = ia === node ? ib : ia;
      if (path.includes(other) && other !== endIdx) continue;
      // Prefer staying on the tab outline (x ≥ APOTHEM - small tolerance).
      // Skip walks that drop deep into the body wall.
      if (nodes[other].x < APOTHEM - 0.1) continue;
      const newUsed = new Set(usedSegs);
      newUsed.add(s);
      const newPath = path.concat(other);
      stack.push({ node: other, path: newPath, usedSegs: newUsed });
    }
  }
  return null;
}

const outlineNodeIdx = dfsPath();
if (!outlineNodeIdx) {
  console.error("Could not find outline path from start to end body-face node.");
  process.exit(3);
}

let outlinePath = outlineNodeIdx.map((i) => ({ x: nodes[i].x, z: nodes[i].z }));

// Pick the outline branch that has the highest peak protrusion (the actual tab).
// (There can be multiple paths if the body has cavity geometry crossing y=0.)
// Validate: max prot must exceed 0.3 mm (tab is ≈0.48 mm; body face is 0).
let peak = 0;
for (const p of outlinePath) {
  const pr = p.x - APOTHEM;
  if (pr > peak) peak = pr;
}
if (peak < 0.3) {
  console.error(
    `Outline peak prot ${peak.toFixed(3)} too small — wrong branch?`,
  );
  process.exit(4);
}

// Normalize direction: low z -> high z
if (outlinePath[0].z > outlinePath[outlinePath.length - 1].z)
  outlinePath = outlinePath.reverse();

// ---------- compute stats and detect shelf ----------
const zStart = outlinePath[0].z;
const zEnd = outlinePath[outlinePath.length - 1].z;
const totalZ = zEnd - zStart;

// Shelf detector: scan for a sharp drop in protrusion (> 5 mm/mm slope) AFTER
// the peak, indicating a tail step rather than smooth decay.
let shelfFound = false;
let shelfDetail = "";
{
  const protPts = outlinePath.map((p) => ({ prot: p.x - APOTHEM, z: p.z }));
  let pkI = 0;
  for (let i = 1; i < protPts.length; i++) {
    if (protPts[i].prot > protPts[pkI].prot) pkI = i;
  }
  let maxAbsSlope = 0;
  let kinkZ = 0;
  for (let i = pkI; i < protPts.length - 1; i++) {
    const dprot = protPts[i + 1].prot - protPts[i].prot;
    const dz = protPts[i + 1].z - protPts[i].z;
    if (dz < 1e-4) continue;
    const slope = Math.abs(dprot / dz);
    if (slope > maxAbsSlope) {
      maxAbsSlope = slope;
      kinkZ = protPts[i].z;
    }
  }
  shelfFound = maxAbsSlope > 0.4;
  shelfDetail = `maxRearSlope=${maxAbsSlope.toFixed(3)} mm/mm at z_abs≈${kinkZ.toFixed(3)}`;
}

// ---------- build polygon ----------
const polygon: Array<[number, number]> = [];
polygon.push([-EMBED, 0]);
for (const p of outlinePath) {
  const prot = Math.max(0, p.x - APOTHEM);
  const zLocal = p.z - zStart;
  polygon.push([prot, zLocal]);
}
polygon.push([-EMBED, totalZ]);

// Drop consecutive duplicates
const deduped: Array<[number, number]> = [];
for (const p of polygon) {
  if (deduped.length === 0) {
    deduped.push(p);
    continue;
  }
  const q = deduped[deduped.length - 1];
  if (Math.abs(q[0] - p[0]) < 1e-5 && Math.abs(q[1] - p[1]) < 1e-5) continue;
  deduped.push(p);
}

function round(n: number, p: number): number {
  const k = 10 ** p;
  return Math.round(n * k) / k;
}

const result = {
  source: "y=0 mesh slice (proper plane intersection, no resampling)",
  shelfFound,
  shelfDetails: shelfDetail,
  tabZStartAbs: round(zStart, 4),
  tabZStartLocal: round(zStart - FLANGE_HEIGHT, 4),
  tabZEndAbs: round(zEnd, 4),
  totalZ: round(totalZ, 4),
  peakProtrude: round(peak, 4),
  pointsCount: deduped.length,
  points: deduped.map(
    ([x, z]) => [round(x, 5), round(z, 5)] as [number, number],
  ),
};

fs.writeFileSync(JSON_OUT_PATH, JSON.stringify(result, null, 2));

// ---------- patch library.ts ----------
const lib = fs.readFileSync(LIBRARY_TS_PATH, "utf8");
const peakRe = /(POLY_PEAK\s*=\s*)([0-9.+\-eE]+)(;)/;
const rawRe = /(POLY_RAW\s*=\s*\[)([\s\S]*?)(\]\s*;)/;
if (!peakRe.test(lib) || !rawRe.test(lib)) {
  console.error("Failed to find POLY_PEAK or POLY_RAW in library.ts");
  process.exit(5);
}
const newPeak = result.peakProtrude;
const newRaw = result.points.map(([x, z]) => `    [${x}, ${z}],`).join("\n");
const patched = lib
  .replace(peakRe, (_m, a, _b, c) => `${a}${newPeak}${c}`)
  .replace(rawRe, (_m, a, _b, c) => `${a}\n${newRaw}\n  ${c}`);
fs.writeFileSync(LIBRARY_TS_PATH, patched);

// ---------- report ----------
console.log("=== tab polygon v2 extraction ===");
console.log("Source:               ", result.source);
console.log("Points:               ", result.pointsCount);
console.log("Peak protrusion (mm): ", result.peakProtrude);
console.log("Total Z (mm):         ", result.totalZ);
console.log("Tab Z start abs (mm): ", result.tabZStartAbs);
console.log("Tab Z end abs (mm):   ", result.tabZEndAbs);
console.log("Shelf/step found:     ", result.shelfFound);
console.log("Shelf detail:         ", result.shelfDetails);
console.log("JSON written:         ", JSON_OUT_PATH);
console.log("library.ts updated:   ", LIBRARY_TS_PATH);
