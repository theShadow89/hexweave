import type { HexCell, HswParams, InsertSpec, TileSpec, Vec2 } from "@/types";
import { cellCircumradius, cellPitch } from "@/lib/hsw/honeycomb";

/**
 * Cross-bracket inserts for VERTICAL seams. A vertical seam is crossed by a
 * 3-cell HORIZONTAL cluster: one full cell in the left tile, one bisected cell
 * on the seam itself, one full cell in the right tile. The flange is continuous
 * across all three; the body plugs lock the two tiles together — the full
 * lateral cells provide the actual grip. A column of three cells stacked
 * vertically on the seam (every body bisected = half-strength) does NOT work.
 *
 *   tile_left:  ┌─ ... ─[full]──[bisected]──[full]─ ... ─┐
 *                              ^ vertical seam
 *   tile_right: └─ ... ──────────┴──────────────... ─┘
 *
 * Two cluster shapes are used depending on the cluster's position relative to a
 * horizontal seam, so no cell ever ends up quartered (on both x and y seams):
 *   - "peak"   centre at row r, laterals at row r  : used BELOW a y-seam.
 *   - "valley" centre at row r, laterals at row r+1: used ABOVE a y-seam.
 *
 * `count` controls how many clusters per vertical seam:
 *   undefined : auto. 2 clusters per crossing y-seam (one below, one above);
 *               1 cluster at the seam centre when no y-seam crosses.
 *   0         : none.
 *   N > 0     : N clusters per vertical seam, evenly spaced.
 */
export function placeSeamInserts(
  cells: HexCell[],
  seamCells: HexCell[],
  xSeams: number[],
  ySeams: number[],
  params: HswParams,
  count?: number,
): InsertSpec[] {
  if (xSeams.length === 0 || seamCells.length === 0) return [];
  if (count !== undefined && count <= 0) return [];

  const Fcell = cellPitch(params);
  const colSpan = 1.5 * cellCircumradius(params);
  const yTol = Fcell * 0.05;
  const xTol = colSpan * 0.5;

  const byKey = new Map<string, HexCell>();
  for (const c of cells) byKey.set(`${c.col}_${c.row}`, c);

  const fullOnly = (
    l: HexCell | undefined,
    c: HexCell | undefined,
    r: HexCell | undefined,
  ): HexCell[] | null =>
    l && c && r && !l.clipped && !c.clipped && !r.clipped ? [l, c, r] : null;
  const buildPeak = (centreCol: number, centreRow: number): HexCell[] | null =>
    fullOnly(
      byKey.get(`${centreCol - 1}_${centreRow}`),
      byKey.get(`${centreCol}_${centreRow}`),
      byKey.get(`${centreCol + 1}_${centreRow}`),
    );
  const buildValley = (centreCol: number, centreRow: number): HexCell[] | null =>
    fullOnly(
      byKey.get(`${centreCol - 1}_${centreRow + 1}`),
      byKey.get(`${centreCol}_${centreRow}`),
      byKey.get(`${centreCol + 1}_${centreRow + 1}`),
    );

  /**
   * 6-cell cluster anchored to an X-junction (vertical seam at xSeamCol crosses
   * a horizontal seam at ySeamRow). The shape depends on the parity of xSeamCol:
   *
   *   ODD col (no quartered cell at the junction): hourglass.
   *     L1=(col-1, row+1), C1=(col, row), R1=(col+1, row+1)  ← above-y-seam triangle
   *     L2=(col-1, row-1), C2=(col, row-1), R2=(col+1, row-1) ← below-y-seam triangle
   *     The C1-C2 pair is bisected by the x-seam and forms the spine connecting
   *     the two triangles; L1, L2, R1, R2 are full grip cells in the four tiles.
   *
   *   EVEN col (the junction cell is quartered, skipped): ring of 6 around it.
   *     N=(col, row+1), S=(col, row-1) bisected by x-seam (above/below halves).
   *     E_top=(col+1, row), W_top=(col-1, row) odd cells above y-seam (full TR/TL).
   *     E_bot=(col+1, row-1), W_bot=(col-1, row-1) odd cells below (full BR/BL).
   *     The 6 cells form a closed honeycomb ring whose flange union is a donut.
   *
   * In both cases the 4 tiles meeting at the X-junction each receive at least
   * one full grip cell — this is what the previous "2 separate 3-cell clusters"
   * approach failed to provide when the lateral cells fell on the y-seam.
   */
  const buildCrossCluster = (xSeamCol: number, ySeamRow: number): HexCell[] | null => {
    const oddCol = (((xSeamCol % 2) + 2) % 2) === 1;
    const wanted: Array<[number, number]> = oddCol
      ? [
          [xSeamCol - 1, ySeamRow + 1],
          [xSeamCol, ySeamRow],
          [xSeamCol + 1, ySeamRow + 1],
          [xSeamCol - 1, ySeamRow - 1],
          [xSeamCol, ySeamRow - 1],
          [xSeamCol + 1, ySeamRow - 1],
        ]
      : [
          [xSeamCol, ySeamRow + 1],
          [xSeamCol + 1, ySeamRow],
          [xSeamCol + 1, ySeamRow - 1],
          [xSeamCol, ySeamRow - 1],
          [xSeamCol - 1, ySeamRow - 1],
          [xSeamCol - 1, ySeamRow],
        ];
    const out: HexCell[] = [];
    for (const [c, r] of wanted) {
      const cell = byKey.get(`${c}_${r}`);
      // Wall-border partials lack full body walls for the clip to grip;
      // bail and let auto fall back to peak/valley pairs further inside.
      if (!cell || cell.clipped) return null;
      out.push(cell);
    }
    return out;
  };

  const inserts: InsertSpec[] = [];
  const pushed = new Set<string>();
  const pushCluster = (
    cluster: HexCell[] | null,
    idOverride?: string,
  ): boolean => {
    if (!cluster) return false;
    const id =
      idOverride ??
      `insert_${cluster[1].col}_${cluster[1].row}_h${cluster.length}`;
    if (pushed.has(id)) return false;
    pushed.add(id);
    inserts.push({
      id,
      kind: "clip",
      centers: cluster.map((c) => c.center),
      tileId: "seam",
    });
    return true;
  };

  const placeCrossOrFallback = (
    xSeamCol: number,
    yseam: number,
    run: HexCell[],
  ): void => {
    const ySeamRow = Math.round(yseam / Fcell);
    const cross = buildCrossCluster(xSeamCol, ySeamRow);
    if (cross) {
      pushCluster(cross, `cross_${xSeamCol}_${ySeamRow}_h6`);
      return;
    }
    // X-junction too close to a wall edge → fall back to "above + below" pair.
    let belowRow: number | null = null;
    let aboveRow: number | null = null;
    for (const c of run) {
      if (c.center[1] < yseam - yTol) {
        belowRow = belowRow === null ? c.row : Math.max(belowRow, c.row);
      } else if (c.center[1] > yseam + yTol) {
        aboveRow = aboveRow === null ? c.row : Math.min(aboveRow, c.row);
      }
    }
    if (belowRow !== null) pushCluster(buildPeak(xSeamCol, belowRow));
    if (aboveRow !== null) pushCluster(buildValley(xSeamCol, aboveRow));
  };

  for (const xSeam of xSeams) {
    const run = seamCells
      .filter((c) => Math.abs(c.center[0] - xSeam) < xTol)
      .sort((a, b) => a.row - b.row);
    if (run.length === 0) continue;
    const xSeamCol = run[0].col;

    const runMinY = run[0].center[1] - Fcell / 2;
    const runMaxY = run[run.length - 1].center[1] + Fcell / 2;
    const crossings = ySeams
      .filter((y) => y > runMinY && y < runMaxY)
      .sort((a, b) => a - b);

    if (count === undefined) {
      if (crossings.length === 0) {
        const midRow = run[Math.floor(run.length / 2)].row;
        if (!pushCluster(buildPeak(xSeamCol, midRow))) {
          pushCluster(buildValley(xSeamCol, midRow));
        }
        continue;
      }
      // One 6-cell cross-cluster per X-junction.
      for (const yseam of crossings) placeCrossOrFallback(xSeamCol, yseam, run);
    } else {
      const wanted = Math.min(Math.floor(count), run.length);
      for (let i = 0; i < wanted; i++) {
        const slotCentre = ((i + 0.5) / wanted) * run.length;
        const idx = Math.min(run.length - 1, Math.floor(slotCentre));
        const centre = run[idx];
        // If this slot sits near a y-seam crossing, use the 6-cell cluster.
        const nearestCrossing = crossings.find(
          (y) => Math.abs(y - centre.center[1]) < Fcell * 0.7,
        );
        if (nearestCrossing !== undefined) {
          placeCrossOrFallback(xSeamCol, nearestCrossing, run);
          continue;
        }
        if (!pushCluster(buildPeak(xSeamCol, centre.row))) {
          pushCluster(buildValley(xSeamCol, centre.row));
        }
      }
    }
  }
  return inserts;
}

/** Target spacing (mm) between bridge inserts when `count` is auto. */
const AUTO_BRIDGE_SPACING_MM = 200;

/**
 * Bridge inserts for HORIZONTAL seams. A horizontal seam in flat-top lattice
 * bisects only every-other column (even cols sit centred on the seam, odd cols
 * straddle it). The bisected cells are then NOT honeycomb-adjacent to one
 * another (they're 2 columns apart), so a multi-cell insert can't span them.
 *
 * The fix is to bind the two tiles using the FULL odd-col cells that sit
 * Fcell/2 below and Fcell/2 above the seam — those ARE honeycomb-adjacent
 * (same column, consecutive rows) and produce a real 2-cell joint whose flange
 * crosses the seam line.
 *
 * `count` controls how many bridges per seam:
 *   undefined : auto. max(1, ceil(seamLength / 200 mm)).
 *   0         : none.
 *   N > 0     : exactly N bridges per seam, evenly distributed.
 */
export function placeBridgeInserts(
  cells: HexCell[],
  ySeams: number[],
  params: HswParams,
  count?: number,
  /**
   * Cell keys (`col_row`) already consumed by other inserts (typically
   * vertical-seam clusters from placeSeamInserts). A bridge that would
   * sit on any of these cells is skipped — otherwise the bridge body
   * collides with the cluster body inside the same panel cell, producing
   * the visible "yellow over orange" overlap the user reported.
   */
  usedCellKeys?: ReadonlySet<string>,
): InsertSpec[] {
  if (ySeams.length === 0) return [];
  if (count !== undefined && count <= 0) return [];
  const Fcell = cellPitch(params);
  const tol = Fcell * 0.05;

  const byKey = new Map<string, HexCell>();
  for (const c of cells) byKey.set(`${c.col}_${c.row}`, c);

  const out: InsertSpec[] = [];
  for (const ySeam of ySeams) {
    const yBelow = ySeam - Fcell / 2;
    const yAbove = ySeam + Fcell / 2;

    const pairs: Array<{ below: HexCell; above: HexCell }> = [];
    for (const below of cells) {
      if (below.clipped) continue; // wall-border partials don't anchor a bridge
      if (Math.abs(below.center[1] - yBelow) > tol) continue;
      if (usedCellKeys?.has(`${below.col}_${below.row}`)) continue;
      const above = byKey.get(`${below.col}_${below.row + 1}`);
      if (!above || above.clipped) continue;
      if (Math.abs(above.center[1] - yAbove) > tol) continue;
      if (usedCellKeys?.has(`${above.col}_${above.row}`)) continue;
      pairs.push({ below, above });
    }
    if (pairs.length === 0) continue;
    pairs.sort((a, b) => a.below.center[0] - b.below.center[0]);

    let wantedCount: number;
    if (count === undefined) {
      const seamLen =
        pairs[pairs.length - 1].below.center[0] - pairs[0].below.center[0];
      wantedCount = Math.max(1, Math.ceil(seamLen / AUTO_BRIDGE_SPACING_MM));
    } else {
      wantedCount = Math.floor(count);
    }
    wantedCount = Math.min(wantedCount, pairs.length);

    const picked: typeof pairs =
      wantedCount >= pairs.length
        ? pairs
        : Array.from({ length: wantedCount }, (_, i) => {
            const idx = Math.floor(((i + 0.5) * pairs.length) / wantedCount);
            return pairs[idx];
          });

    for (const { below, above } of picked) {
      out.push({
        id: `bridge_${below.col}_${below.row}`,
        kind: "clip",
        centers: [below.center, above.center],
        tileId: "seam",
      });
    }
  }
  return out;
}

/**
 * Build the `snapTargets` set from a list of clip InsertSpecs. Returns the
 * `col_row` keys of every clip cell that is NOT bisected (those are the cells
 * a wall mount can safely take over via mergeWallMountsIntoClips).
 */
export function clipFullCellKeys(
  clips: InsertSpec[],
  allCells: HexCell[],
  seamCells: HexCell[],
): Set<string> {
  const seamKeys = new Set(seamCells.map((c) => `${c.col}_${c.row}`));
  const out = new Set<string>();
  for (const clip of clips) {
    if (clip.kind !== "clip") continue;
    for (const centre of clip.centers) {
      const cell = allCells.find(
        (c) =>
          Math.abs(c.center[0] - centre[0]) < 0.5 &&
          Math.abs(c.center[1] - centre[1]) < 0.5,
      );
      if (!cell) continue;
      const k = `${cell.col}_${cell.row}`;
      if (seamKeys.has(k)) continue;
      out.add(k);
    }
  }
  return out;
}

/**
 * Auto wall-mount count for the whole wall (not per tile). The count is the
 * structural minimum to hold the panel hung against a wall:
 *   - < 200 mm longest side: 1 mount (small single-tile panel).
 *   - otherwise: max(2, ceil(longest / 400)) — 2 minimum for anti-tilt,
 *     plus one mount per 400 mm of the longest dimension to fight bending.
 * The user can always force a higher count from the UI if they want more
 * support on the perimeter.
 */
function autoWallMountsForWall(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest < 200) return 1;
  return Math.max(2, Math.ceil(longest / 400));
}

function generateTargets(
  minX: number,
  minY: number,
  width: number,
  height: number,
  n: number,
): Vec2[] {
  if (n <= 0) return [];
  if (n === 1) return [[minX + width / 2, minY + height / 2]];
  if (n === 2) {
    return width >= height
      ? [
          [minX + width * 0.25, minY + height / 2],
          [minX + width * 0.75, minY + height / 2],
        ]
      : [
          [minX + width / 2, minY + height * 0.25],
          [minX + width / 2, minY + height * 0.75],
        ];
  }
  if (n === 3) {
    return width >= height
      ? [
          [minX + width * 0.2, minY + height / 2],
          [minX + width * 0.5, minY + height / 2],
          [minX + width * 0.8, minY + height / 2],
        ]
      : [
          [minX + width / 2, minY + height * 0.2],
          [minX + width / 2, minY + height * 0.5],
          [minX + width / 2, minY + height * 0.8],
        ];
  }
  if (n === 4) {
    return [
      [minX + width * 0.2, minY + height * 0.25],
      [minX + width * 0.8, minY + height * 0.25],
      [minX + width * 0.2, minY + height * 0.75],
      [minX + width * 0.8, minY + height * 0.75],
    ];
  }
  // General grid for higher counts.
  const cols = Math.max(1, Math.round(Math.sqrt((n * width) / Math.max(1, height))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const out: Vec2[] = [];
  for (let r = 0; r < rows && out.length < n; r++) {
    for (let c = 0; c < cols && out.length < n; c++) {
      out.push([
        minX + (width * (c + 0.5)) / cols,
        minY + (height * (r + 0.5)) / rows,
      ]);
    }
  }
  return out;
}

/**
 * Fold wall mounts into clip clusters when they fall on the same lattice cell.
 * The cluster cell gets a countersunk M3 hole (mountIndices) instead of the
 * usual hex inner hole, and the standalone wall mount is dropped — one printed
 * part now does both jobs: locks the seam AND screws the panel to the wall.
 *
 * Returns the merged clips (some now carry mountIndices) and the wall mounts
 * that didn't coincide with any cluster cell (still printed standalone).
 */
export function mergeWallMountsIntoClips(
  clips: InsertSpec[],
  mounts: InsertSpec[],
  tol = 0.5,
): { clips: InsertSpec[]; mounts: InsertSpec[] } {
  const mergedClips: InsertSpec[] = clips.map((c) => ({
    ...c,
    mountIndices: c.mountIndices ? [...c.mountIndices] : undefined,
  }));
  const consumed = new Set<number>();

  for (let mi = 0; mi < mounts.length; mi++) {
    const mountCentre = mounts[mi].centers[0];
    outer: for (const clip of mergedClips) {
      if (clip.kind !== "clip") continue;
      for (let ci = 0; ci < clip.centers.length; ci++) {
        const cc = clip.centers[ci];
        if (Math.abs(cc[0] - mountCentre[0]) < tol && Math.abs(cc[1] - mountCentre[1]) < tol) {
          const list = clip.mountIndices ?? [];
          if (!list.includes(ci)) list.push(ci);
          clip.mountIndices = list;
          consumed.add(mi);
          break outer;
        }
      }
    }
  }

  const remainingMounts = mounts.filter((_, i) => !consumed.has(i));
  return { clips: mergedClips, mounts: remainingMounts };
}

/**
 * Pick wall-mount cells for the WHOLE wall (not per tile). The count is the
 * total number of M3 countersunk inserts that screw the panel to the wall;
 * `auto` computes the structural minimum from the wall's longest side. Mounts
 * are distributed uniformly across the wall bbox, snapped onto clip cluster
 * cells when one is close to the ideal position (so mergeWallMountsIntoClips
 * folds them into the cluster — one printed part does both jobs).
 *
 *   countTotal undefined -> auto: 1 if wall < 200 mm, else max(2, ceil(longest/400))
 *   countTotal = 0       -> none
 *   countTotal = N > 0   -> exactly N mounts, distributed evenly
 *
 * The user can always force a higher count to add more support on the perimeter.
 */
export function placeWallMountInserts(
  tiles: TileSpec[],
  seamCells: HexCell[],
  countTotal?: number,
  snapTargets: ReadonlySet<string> = new Set(),
): InsertSpec[] {
  if (countTotal !== undefined && countTotal <= 0) return [];
  if (tiles.length === 0) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tiles) {
    if (t.bbox.min[0] < minX) minX = t.bbox.min[0];
    if (t.bbox.min[1] < minY) minY = t.bbox.min[1];
    if (t.bbox.max[0] > maxX) maxX = t.bbox.max[0];
    if (t.bbox.max[1] > maxY) maxY = t.bbox.max[1];
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const total = countTotal ?? autoWallMountsForWall(w, h);
  if (total <= 0) return [];

  const seamKeys = new Set(seamCells.map((c) => `${c.col}_${c.row}`));
  type Candidate = { cell: HexCell; tileId: string };
  const allEligible: Candidate[] = [];
  const allSnap: Candidate[] = [];
  for (const tile of tiles) {
    for (const cell of tile.cells) {
      const key = `${cell.col}_${cell.row}`;
      if (seamKeys.has(key)) continue;
      if (cell.clipped) continue; // wall-border partials can't host a wall mount
      const cand: Candidate = { cell, tileId: tile.id };
      allEligible.push(cand);
      if (snapTargets.has(key)) allSnap.push(cand);
    }
  }
  if (allEligible.length === 0) return [];

  const targets = generateTargets(minX, minY, w, h, total);
  const used = new Set<string>();
  const out: InsertSpec[] = [];
  for (const t of targets) {
    const snapPool = allSnap.filter(
      (c) => !used.has(`${c.cell.col}_${c.cell.row}`),
    );
    const fallbackPool = allEligible.filter(
      (c) => !used.has(`${c.cell.col}_${c.cell.row}`),
    );
    const pool = snapPool.length > 0 ? snapPool : fallbackPool;
    if (pool.length === 0) break;
    let best = pool[0];
    let bestD = Infinity;
    for (const item of pool) {
      const dx = item.cell.center[0] - t[0];
      const dy = item.cell.center[1] - t[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    used.add(`${best.cell.col}_${best.cell.row}`);
    out.push({
      id: `mount_${best.cell.col}_${best.cell.row}`,
      kind: "wallMount",
      centers: [best.cell.center],
      tileId: best.tileId,
    });
  }
  return out;
}
