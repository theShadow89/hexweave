import type { HswParams, Polygon, Vec2 } from "@/types";
import type { SnapStepSpec } from "@/lib/hsw/constants";
import { DEFAULT_SNAP_STEP } from "@/lib/hsw/constants";
import { HSW_SCAD_LIBRARY } from "./library";

const DEFAULT_FN = 32;

export interface PanelCell {
  center: Vec2 | readonly [number, number];
  /**
   * When set, the cell hole is clipped to this polygon. By default the clipped
   * hex still gets the full snap-step profile (front pocket, rear groove, etc.)
   * — same features as a full cell — so half-cells at panel edges remain
   * compatible with the clip inserts. This lets users extend the wall later
   * by butting another panel against this edge. Set `clipNoSnap = true` to
   * fall back to a straight extrusion (the original behaviour when a closed
   * frame seals the panel).
   */
  clipped?: Polygon;
  /** Opt-out of snap features for a clipped cell — straight extrusion only. */
  clipNoSnap?: boolean;
}

/** Format a number as a SCAD literal — fixed decimals, no scientific notation. */
function n(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`SCAD: non-finite value ${x}`);
  if (Number.isInteger(x)) return x.toString();
  return x.toFixed(6).replace(/\.?0+$/, "");
}

function polygonLiteral(poly: Polygon | readonly (readonly [number, number])[]): string {
  return `[${poly.map(([x, y]) => `[${n(x)}, ${n(y)}]`).join(", ")}]`;
}

/**
 * Generate the SCAD source that produces a tile mesh.
 *
 *   panel_solid = linear_extrude(depth, outline)
 *   holes       = union of (stepped_hex_hole at each cell)
 *   tile        = panel_solid - holes
 *
 * Border-clipped cells (with `clipped` set) bypass the snap step and extrude
 * their truncated polygon straight through — same fallback as the manifold
 * pipeline.
 */
export function genTileScad(
  outline: Polygon,
  cells: PanelCell[],
  params: HswParams,
  snapStep: SnapStepSpec = DEFAULT_SNAP_STEP,
): string {
  const depth = params.depth;
  const pointy = params.orientation === "pointy" ? "true" : "false";
  // cellHoleExpansion (default 0) grows every flat width in the hex hole by
  // 2*expansion (= expansion per side) so PLA/ABS panels can host original
  // PETG inserts at the same fit as an all-PETG assembly. See MATERIAL_PROFILES
  // in constants.ts and HswParams.cellHoleExpansion in types/index.ts.
  const expansion = params.cellHoleExpansion ?? 0;
  const holeGrowth = 2 * expansion;
  const frontFlat = params.cellInnerWidth + holeGrowth;
  const stepEnabled = snapStep.enabled;
  const rearFlat = stepEnabled ? snapStep.rearFlat + holeGrowth : frontFlat;
  const stepStart = stepEnabled ? Math.max(0, Math.min(snapStep.stepStartZ, depth)) : depth;
  const stepEnd = stepEnabled
    ? Math.max(stepStart, Math.min(snapStep.stepEndZ, depth))
    : depth;
  // Flange pocket at the front face (z=0..pocketDepth, wider hex). Reproduces
  // the L-shaped cross-section of the original RostaP panel — recesses the
  // insert flange by 0.5 mm so 2 mm protrudes instead of 2.5 mm. Set
  // pocketDepth=0 in snapStep to skip.
  const pocketFlatBase = snapStep.pocketFlat ?? 0;
  const pocketFlat = pocketFlatBase > 0 ? pocketFlatBase + holeGrowth : 0;
  const pocketDepth = snapStep.pocketDepth ?? 0;

  const lines: string[] = [];
  lines.push(`$fn = ${DEFAULT_FN};`);
  lines.push(HSW_SCAD_LIBRARY);
  lines.push(`outline_pts = ${polygonLiteral(outline)};`);
  lines.push(`module panel_solid() { linear_extrude(height=${n(depth)}) polygon(points=outline_pts); }`);

  // Emit holes. Three buckets:
  //   - full cells              → centred stepped_hex_hole
  //   - clipped + snap (default) → stepped_hex_hole INTERSECTED with extruded
  //                                clip polygon (preserves half-cell snap
  //                                relief so the edge can host clip inserts
  //                                when another panel is butted against it)
  //   - clipped + no-snap (opt-in) → straight extrusion (legacy behaviour
  //                                  when a closed frame seals the panel)
  const fullCellPositions: Array<readonly [number, number]> = [];
  const clippedSnap: Array<{ center: readonly [number, number]; poly: Polygon }> = [];
  const clippedStraight: Array<Polygon> = [];
  for (const cell of cells) {
    if (cell.clipped) {
      if (cell.clipNoSnap) {
        clippedStraight.push(cell.clipped);
      } else {
        clippedSnap.push({ center: cell.center as readonly [number, number], poly: cell.clipped });
      }
    } else {
      fullCellPositions.push(cell.center as readonly [number, number]);
    }
  }

  lines.push(`module full_holes() {`);
  if (fullCellPositions.length > 0) {
    lines.push(`  centres = ${polygonLiteral(fullCellPositions)};`);
    if (stepEnabled) {
      lines.push(`  for (c = centres)`);
      lines.push(`    translate([c[0], c[1], 0])`);
      lines.push(`      stepped_hex_hole(${n(frontFlat)}, ${n(rearFlat)}, ${n(stepStart)}, ${n(stepEnd)}, ${n(depth)}, ${n(pocketFlat)}, ${n(pocketDepth)}, ${pointy});`);
    } else {
      lines.push(`  for (c = centres)`);
      lines.push(`    translate([c[0], c[1], 0])`);
      lines.push(`      straight_hex_hole(${n(frontFlat)}, ${n(depth)}, ${pointy});`);
    }
  }
  lines.push(`}`);

  lines.push(`module clipped_snap_holes() {`);
  for (let i = 0; i < clippedSnap.length; i++) {
    const { center: [cx, cy], poly } = clippedSnap[i];
    if (stepEnabled) {
      lines.push(`  intersection() {`);
      lines.push(`    translate([${n(cx)}, ${n(cy)}, 0]) stepped_hex_hole(${n(frontFlat)}, ${n(rearFlat)}, ${n(stepStart)}, ${n(stepEnd)}, ${n(depth)}, ${n(pocketFlat)}, ${n(pocketDepth)}, ${pointy});`);
      lines.push(`    translate([0, 0, -0.05]) linear_extrude(height=${n(depth + 0.1)}) polygon(points=${polygonLiteral(poly)});`);
      lines.push(`  }`);
    } else {
      lines.push(`  translate([0, 0, -0.05]) linear_extrude(height=${n(depth + 0.1)}) polygon(points=${polygonLiteral(poly)});`);
    }
  }
  lines.push(`}`);

  lines.push(`module clipped_straight_holes() {`);
  for (let i = 0; i < clippedStraight.length; i++) {
    lines.push(`  translate([0, 0, -0.05]) linear_extrude(height=${n(depth + 0.1)}) polygon(points=${polygonLiteral(clippedStraight[i])});`);
  }
  lines.push(`}`);

  lines.push(`difference() {`);
  lines.push(`  panel_solid();`);
  lines.push(`  union() { full_holes(); clipped_snap_holes(); clipped_straight_holes(); }`);
  lines.push(`}`);
  return lines.join("\n");
}
