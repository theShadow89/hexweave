import type { HswParams, Mesh, Vec2 } from "@/types";
import { cellPitch } from "@/lib/hsw/honeycomb";
import { runOpenScad } from "@/lib/openscad/openscadClient";
import { genInsertScad, genWallMountScad } from "@/lib/openscad/scad/insert";

const EMPTY_MESH: Mesh = { positions: new Float32Array(0), indices: new Uint32Array(0) };

/**
 * What a single cell of an insert looks like inside. The clip body always exists
 * (it's what holds the insert in the panel hole); the variant controls the
 * inner cavity / hole, the flange front feature, and whether a nut pocket is
 * embedded in the body.
 *
 *   empty            — clip with hex hollow cavity (default; matches insert-empty.stl)
 *   solid            — clip fully solid, no cavity (matches "Covered")
 *   hollow           — Ø10 mm cylindrical cavity (matches insert-hollow-for.stl)
 *   m3 / m4 / m5     — Ø shaft hole + hex nut pocket at the rear of the body
 *   countersunk-m3   — Ø5.8 head pocket on the flange + Ø3.5 shaft (wall mount)
 *   countersunk-m4   — Ø8.0 head + Ø4.5 shaft
 *   countersunk-m5   — Ø10.0 head + Ø5.5 shaft
 */
export type CellVariant =
  | "empty"
  | "solid"
  | "hollow"
  | "m3"
  | "m4"
  | "m5"
  | "countersunk-m3"
  | "countersunk-m4"
  | "countersunk-m5";

export const ALL_CELL_VARIANTS: CellVariant[] = [
  "empty",
  "solid",
  "hollow",
  "m3",
  "m4",
  "m5",
  "countersunk-m3",
  "countersunk-m4",
  "countersunk-m5",
];

export const CELL_VARIANT_LABELS: Record<CellVariant, string> = {
  empty: "Empty (hex cavity)",
  solid: "Solid (covered)",
  hollow: "Hollow (Ø10 cylinder)",
  m3: "Nut M3",
  m4: "Nut M4",
  m5: "Nut M5",
  "countersunk-m3": "Countersunk M3",
  "countersunk-m4": "Countersunk M4",
  "countersunk-m5": "Countersunk M5",
};

export interface InsertParams {
  /** Per-side clearance between insert body and the cell hole (mm). */
  clipClearance: number;
  /** Flange flat-to-flat dimension; sits on the panel front and blocks back-fall (mm). */
  flangeWidth: number;
  /** Flange thickness; protrudes from the panel front when assembled (mm). */
  flangeHeight: number;
  /** Panel depth the body passes through (mm). Should match HswParams.depth. */
  panelDepth: number;
  /**
   * DEPRECATED / IGNORED. The barbed_tab module in scad/library.ts now uses
   * the EXACT polygon extracted from the original Insert-countersunk.stl
   * (see scripts/extract-tab-polygon-v2.ts). Kept on the type for API stability.
   * Front (entry) chamfer of the rear locking tab. Protrusion ramps 0 →
   * tabProtrude (mm).
   */
  tabFrontBevel: number;
  /**
   * DEPRECATED / IGNORED. See tabFrontBevel — the polygon in library.ts
   * encodes the full plateau. Full-protrusion plateau between the two
   * chamfers (mm).
   */
  tabPlateau: number;
  /**
   * DEPRECATED / IGNORED. See tabFrontBevel. Rear (exit) chamfer of the tab.
   * Protrusion ramps tabProtrude → 0 (mm).
   */
  tabRearBevel: number;
  /** Outward protrusion of each tab past the body hex flat (mm). */
  tabProtrude: number;
  /** Width of each tab measured along the hex flat (mm). */
  tabWidth: number;
  /** Inner hole flat-to-flat (mm); 0 produces a solid plug. */
  innerHoleWidth: number;
  /** Distance the insert's leading tip stops short of the panel's back face (mm). */
  tipRecess: number;
  /** Hex edge indices (0..5) where tabs are placed on a SINGLE-cell insert. */
  tabEdges: number[];
  /**
   * Z position (insert local coords, panel face = 0) where the tab section
   * STARTS. Setting this explicitly decouples tab placement from tab size;
   * leave undefined to fall back to the legacy "tabs at body end" formula
   * `panelDepth - tabZoneH - tipRecess`. Matches the original RostaP design,
   * where tabs sit in the middle of the body (z=5..6.24 in panel coords) with
   * additional body main material above the tab section before the tip chamfer.
   */
  tabZStart?: number;
}

export const DEFAULT_INSERT: InsertParams = {
  clipClearance: 0.2,
  flangeWidth: 22.5,
  flangeHeight: 2.5,
  panelDepth: 8,
  // tabFrontBevel / tabPlateau / tabRearBevel are IGNORED at render time —
  // barbed_tab in scad/library.ts is built from the EXACT 2D polygon extracted
  // from the original Insert-countersunk.stl via scripts/extract-tab-polygon-v2.ts
  // (y=0 slice at edge-midpoint theta=30°, walked as a closed polyline with NO
  // resampling — every mesh vertex on the slice is preserved). The numbers below
  // remain as design-intent documentation only:
  //
  //   Absolute Z (z=0 = flange tip face): tabs span z = 7.5 .. 9.6 mm.
  //   Total tab Z extent (from v2 polygon): 2.10 mm, including the snap-catch
  //     shelf tail (kink at z_local ≈ 1.67 mm with prot ≈ 0.17 mm) that
  //     engages the panel rear groove. The v1 extractor truncated at
  //     z_local = 1.24 mm and missed this shelf.
  //   Peak protrusion (from v2 polygon): POLY_PEAK = 0.4782 mm.
  //   In our local coords (subtract 2.5 for flange height): tabZStart = 5.0.
  //
  // tabProtrude IS still used: barbed_tab scales the polygon's x values by
  // (tabProtrude / POLY_PEAK) so callers can grow/shrink the radial bump
  // proportionally; the polygon's z extent is fixed at 2.10 mm.
  //
  // Why 0.525 (not the polygon peak 0.4782): the polygon was extracted from a
  // single Y=0 slice of the original STL, which captures the tab outline at
  // the exact tangent centre. The validator measures the original's max
  // outer R as 10.42 mm = apothem 9.895 + 0.525. The 0.05 mm residual is
  // material that exists at y ≠ 0 (lateral chamfer / fillet on the tab body
  // that adds protrusion off the central tangent plane) and isn't captured
  // by a single Y=0 polygon. Scaling the polygon's x by 0.525/0.4782 = 1.098
  // closes that peak residual; the snap-catch shelf is already encoded in
  // the v2 polygon itself.
  tabFrontBevel: 0.62,
  tabPlateau: 0.34,
  tabRearBevel: 0.40,
  tabProtrude: 0.525,
  tabWidth: 2.0,
  // Empty variant: central hex hole through body+flange (per spec). A separate
  // wall of material stays BETWEEN this central hole and the L-svaso (tab
  // relief slot + canal), so the L is fully isolated from the central cavity.
  innerHoleWidth: 13,
  tipRecess: 0.5,
  // Tabs start at insert local z=5.0 (= panel z=5.0 with POCKET_DEPTH=0),
  // matching the measured original RostaP tab Z start (polygon tabZStartAbs
  // = 7.5, minus flangeHeight 2.5).
  tabZStart: 5.0,
  // Unused for clip inserts: the SCAD generator chooses edges per cell via
  // clusterTabEdges (6 edges minus those that face another cluster cell).
  // Kept on the type for backwards compatibility.
  tabEdges: [0, 1, 2, 3, 4, 5],
};

export interface WallMountParams {
  clipClearance: number;
  flangeWidth: number;
  flangeHeight: number;
  panelDepth: number;
  /**
   * DEPRECATED / IGNORED. See InsertParams.tabFrontBevel — barbed_tab in
   * scad/library.ts uses the exact polygon from the original
   * Insert-countersunk.stl. Kept for API stability.
   */
  tabFrontBevel: number;
  /** DEPRECATED / IGNORED. See InsertParams.tabPlateau. */
  tabPlateau: number;
  /** DEPRECATED / IGNORED. See InsertParams.tabRearBevel. */
  tabRearBevel: number;
  tabProtrude: number;
  tabWidth: number;
  /** Screw shaft clearance hole diameter (mm). 3.5 = M3, 4.5 = M4, 5.5 = M5. */
  screwHoleDiameter: number;
  /** Countersunk head pocket diameter (mm). This is the screwdriver access
   * well Ø, NOT just the screw head Ø. Original RostaP M3 = Ø10. */
  screwHeadDiameter: number;
  tipRecess: number;
  tabEdges: number[];
  /** Tab section start Z (insert local). See InsertParams.tabZStart. */
  tabZStart?: number;
}

export const DEFAULT_WALL_MOUNT: WallMountParams = {
  clipClearance: 0.2,
  flangeWidth: 22.5,
  flangeHeight: 2.5,
  panelDepth: 8,
  // Same tab profile as DEFAULT_INSERT. fb/pl/rb values below are
  // DEPRECATED / IGNORED — the actual tab geometry is the exact polygon
  // hardcoded in scad/library.ts (extracted from Insert-countersunk.stl).
  // See DEFAULT_INSERT for the full measurement and provenance notes.
  tabFrontBevel: 0.62,
  tabPlateau: 0.34,
  tabRearBevel: 0.40,
  // 0.525 reproduces the original max outer R measured by the validator
  // (10.42 = apothem 9.895 + 0.525). See DEFAULT_INSERT for full rationale.
  tabProtrude: 0.525,
  tabWidth: 2.0,
  screwHoleDiameter: 3.5,
  screwHeadDiameter: 10.0, // matches original RostaP insert-countersung-m3.stl (PDF p.6)
  tipRecess: 0.5,
  // All 6 edges — wall mounts are always single-cell, so every edge has a
  // free rear groove to anchor into. Matches the original RostaP spec.
  tabEdges: [0, 1, 2, 3, 4, 5],
  // Tabs in the middle of the body — see InsertParams.tabZStart.
  tabZStart: 5.0,
};

export interface BuildInsertOptions {
  /**
   * Per-cell variant. Length must match `centers`. Defaults to "empty" for
   * every cell when unset.
   */
  variants?: CellVariant[];
}

/**
 * Build a 1..N-cell clip insert. Geometry produced by OpenSCAD WASM:
 *
 *   z=0..flangeHeight       flange: union of hex(flangeWidth) per centre.
 *   flangeHeight..bodyTop   body: separate hex(bodyWidth) plugs per cell.
 *   bodyTop..panelTop       body + barbed tabs on edges that face open panel
 *                           wall (top + bottom flats, skipped where another
 *                           cluster cell sits at one lattice pitch).
 *
 * Inner cavity per cell follows the variant (hex / circle / shaft / nut pocket).
 * Centres must be sorted bottom-to-top so the cluster-tab-edge heuristic gets
 * the right north/south neighbours.
 */
export async function buildInsertMesh(
  centers: Vec2[],
  params: HswParams,
  insertParams: InsertParams = DEFAULT_INSERT,
  options: BuildInsertOptions = {},
): Promise<Mesh> {
  if (centers.length === 0) return EMPTY_MESH;
  const variants: CellVariant[] = centers.map((_, i) => options.variants?.[i] ?? "empty");
  const pitch = cellPitch(params);
  const scad = genInsertScad(centers, params, insertParams, variants, pitch);
  return runOpenScad(scad);
}

/**
 * Wall-mount insert: single-cell variant of buildInsertMesh with a countersunk
 * screw hole instead of the hexagonal inner cavity.
 */
export async function buildWallMountInsertMesh(
  center: Vec2,
  params: HswParams,
  wallParams: WallMountParams = DEFAULT_WALL_MOUNT,
): Promise<Mesh> {
  const scad = genWallMountScad(center, params, wallParams);
  return runOpenScad(scad);
}
