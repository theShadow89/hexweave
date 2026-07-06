import type {
  BorderOptions,
  HswParams,
  MaterialProfile,
  PlateSpec,
} from "@/types";

// Values measured from the original "Honeycomb storage wall" by RostaP
// (Printables model 152592): wall-honeycomb-part.stl is 170.3 x 177 x 8 mm,
// hexagon inner flat-to-flat 20 mm, inter-cell wall 3.6 mm (= 2 × 1.8 mm:
// each cell contributes a 1.8 mm "half-wall" around itself, so two adjacent
// cells share a 3.6 mm wall and a panel-edge cell has a 1.8 mm border).
// Verified by slicing the original STL at z=3: pitch_X = 23.6 mm, cell inner
// = 20 mm, wall (right-edge cell N → left-edge cell N+1) = 3.6 mm.
export const HSW_STANDARD: HswParams = {
  cellInnerWidth: 20,
  wallThickness: 3.6,
  depth: 8,
  orientation: "flat",
  cellHoleExpansion: 0,
};

/**
 * Preset `cellHoleExpansion` values per print material. Applied to the PANEL
 * cell hole (front_flat, rear_flat and pocket_flat) to compensate for
 * print-material shrinkage / over-extrusion so an original RostaP insert (or
 * one printed in a different material) fits at design clearance.
 *
 *   PETG:  0    mm  RostaP's specified material — no compensation needed
 *   PLA:  +0.15 mm  compensates typical PLA over-extrusion; verified by the
 *                    user's 6-cell test where nominal 20 mm printed ≈19.8 mm
 *                    and an original PETG insert was noticeably tight
 *   ABS:  -0.05 mm  slight negative comp so the hole doesn't END UP oversized
 *                    after cool-down thermal contraction
 *
 * When both panel AND insert are printed in the SAME material both shrink
 * together and the design clearance is preserved — leave the profile at PETG
 * (= 0 compensation) in that case. Use PLA/ABS only when mixing materials or
 * when your printer is known to over/under-extrude.
 *
 * "custom" is a UI hint only; the actual value is `HswParams.cellHoleExpansion`.
 */
export const MATERIAL_PROFILES: Record<MaterialProfile, number> = {
  PETG: 0,
  PLA: 0.15,
  ABS: -0.05,
  custom: 0,
};

export const DEFAULT_MATERIAL_PROFILE: MaterialProfile = "PETG";

/**
 * Given a numeric expansion value, return the matching preset name — or
 * "custom" if it doesn't match any preset. Lets the UI dropdown sync with
 * the underlying scalar in HswParams.cellHoleExpansion.
 */
export function materialProfileFromExpansion(
  expansion: number | undefined,
): MaterialProfile {
  const e = expansion ?? 0;
  for (const key of ["PETG", "PLA", "ABS"] as const) {
    if (Math.abs(MATERIAL_PROFILES[key] - e) < 1e-6) return key;
  }
  return "custom";
}

// Per-cell half-wall (= the wall thickness around a panel-edge cell, which is
// half the inter-cell wall).
export const HALF_WALL_THICKNESS = HSW_STANDARD.wallThickness / 2;

// On the original 170.3x177 tile the distance from the outermost hole to the
// outer panel edge is HALF the inter-cell wall (the cell-edge contributes one
// half-wall, the other half is "missing" because there's no neighbour).
export const DEFAULT_BORDER: BorderOptions = {
  enabled: true,
  thickness: HALF_WALL_THICKNESS,
};

// Insert (clip connector) reference footprint, measured from insert-empty.stl:
// single-cell 25.98 x 22.5 mm, 10 mm tall (2 mm proud of the 8 mm panel = clip).
export const INSERT = {
  footprintWidth: 25.98,
  footprintHeight: 22.5,
  height: 10,
  clipProtrusion: 2,
} as const;

/**
 * Internal snap-fit groove inside every cell hole. Reverse-engineered from
 * wall-honeycomb-part.stl, where the hex hole opens from 20.0 mm flat-to-flat
 * at the front to ~22 mm at the rear via a 0.9 mm chamfer at z=5.1..6.0:
 *
 *   z=0.0 .. 5.1   hex hole 20.0 mm flat-to-flat (= cellInnerWidth)
 *   z=5.1 .. 6.0   linear chamfer 20.0 → rearFlat
 *   z=6.0 .. 8.0   hex hole rearFlat mm flat-to-flat (= rear groove)
 *
 * The clip insert's locking tab (0.5 mm protrusion at full extent) slides
 * through the narrow front section with a small interference fit (0.35 mm of
 * radial flex), springs into the wider rear groove, and catches on the step
 * when the panel is pulled forward. Same mechanism as the original RostaP HSW.
 *
 * `rearFlat` is capped at `pitch - 0.01 = 21.79 mm` so adjacent rear hexes
 * stay just-non-overlapping. OpenSCAD's CGAL CSG produces non-manifold edges
 * when adjacent prisms tangent or overlap (verified empirically: 22.0 →
 * 184 bad edges, 21.8 → 273, 21.79 → 0). 21.79 still gives 0.895 mm of
 * radial groove past the front face — plenty for a 0.5 mm tab plus clearance.
 *
 * Set `enabled: false` to fall back to a straight-through cylinder hole; the
 * resulting panels can't host snap-fit clips and rely on friction only.
 */
export interface SnapStepSpec {
  enabled: boolean;
  stepStartZ: number;
  stepEndZ: number;
  rearFlat: number;
  /** Legacy slab count — unused by the OpenSCAD backend (kept for type compat). */
  chamferSlabs: number;
  /**
   * Front-face flange pocket: hex hole opens at the front face (z=0) to this
   * flat width for `pocketDepth` mm, then narrows to the standard front_flat
   * (20 mm). Matches the L-shaped cross-section of the original RostaP panel.
   * Set pocketDepth=0 to skip.
   */
  pocketFlat: number;
  pocketDepth: number;
}

export const DEFAULT_SNAP_STEP: SnapStepSpec = {
  enabled: true,
  // Match the original RostaP STL exactly: a 0.9 mm linear chamfer spanning
  // z=5.1..6.0 connects the 20 mm cell hole to the 21.6 mm rear groove. We
  // moved off the instant-step shortcut after the OpenSCAD Manifold backend
  // (replacing CGAL) made the gradient transition robust again, and because
  // verifying against the original showed user-side viewers reading the lack
  // of slope as a printability/lockability defect.
  stepStartZ: 5.1,
  stepEndZ: 6.0,
  // 22.0 mm matches the measured original RostaP STL exactly. The previous
  // 21.6 mm value was a CGAL workaround from when wallThickness was 1.8 mm
  // (lattice pitch 21.8 mm); with the corrected 3.6 mm wall the pitch is
  // 23.6 mm, leaving 1.6 mm of clearance between adjacent rear hexes — no
  // tangency issue, no CGAL/Manifold complaints.
  rearFlat: 22.0,
  chamferSlabs: 3,
  // Front-edge chamfer: at z=0 the hole opens to 20.8 mm flat, tapering down
  // to 20 mm (front_flat) at z=0.5. Measured on the original RostaP STL
  // (z=0 layer shows mean R≈12.0 = flat 20.8; z=0.5 shows R≈11.5 = flat 20.0).
  // The chamfer replaces the previous 22.7 mm "flange pocket" (which created
  // a visible step). The insert flange (22.5 mm) no longer fits INSIDE the
  // hole; it sits on top of the panel front face, capping the cell-hole
  // chamfered opening — same as the original design.
  pocketFlat: 20.8,
  pocketDepth: 0.5,
};

export const PLATE_PRESETS: PlateSpec[] = [
  { id: "a1mini", label: "Bambu A1 mini (180x180)", width: 180, height: 180 },
  { id: "bambu256", label: "Bambu A1 / P1 / X1 (256x256)", width: 256, height: 256 },
  { id: "kobras1", label: "Anycubic Kobra S1 (250x250)", width: 250, height: 250 },
  { id: "mk4", label: "Prusa MK4 (250x210)", width: 250, height: 210 },
  { id: "mini", label: "Prusa MINI (180x180)", width: 180, height: 180 },
  { id: "ender3", label: "Ender 3 (220x220)", width: 220, height: 220 },
  { id: "voron350", label: "Voron 2.4 350 (350x350)", width: 350, height: 350 },
];

export const CUSTOM_PLATE_ID = "__custom__";

// Default clearance kept clear of the bed edge (mm).
export const DEFAULT_PLATE_MARGIN = 5;
