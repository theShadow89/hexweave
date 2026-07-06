import type { HswParams, Vec2 } from "@/types";
import type {
  CellVariant,
  InsertParams,
  WallMountParams,
} from "@/lib/hsw/insert";
import { HSW_SCAD_LIBRARY } from "./library";

// Cylindrical cavities only (hollow Ø10, screw shaft/head, nut pockets). Hex
// prisms always use $fn=6. 24 gives 15° resolution, ~0.65 mm facet on a Ø5
// shaft — visually smooth and noticeably faster than 48 in CGAL.
const DEFAULT_FN = 24;
const NUT_CLEARANCE = 0.2;
const HOLLOW_DIAMETER = 10;

// Edge chamfers measured from insert-empty.stl, both 0.30 mm in z. They
// soften the otherwise-sharp outer corners and produce the visible "stepped"
// silhouette of the original RostaP inserts.
//   FLANGE FRONT: flat 21.9 → 22.5 over 0.30 mm (chamfer flares OUTWARD).
//   BODY TIP:    flat 19.5 → 19.3 over 0.40 mm (chamfer narrows INWARD).
const FLANGE_FRONT_CHAMFER_DEPTH = 0.30;
const FLANGE_FRONT_CHAMFER_NARROW = 0.60; // 22.5 - 21.9
const BODY_TIP_CHAMFER_DEPTH = 0.40;
const BODY_TIP_CHAMFER_NARROW = 0.30; // 19.5 - 19.2 (slightly inside the 19.6 body)

// Tab-relief L: edge-midpoint placement (matches original RostaP visually).
// Canal outer offset from body apothem set to 0.8 mm so the body wall in
// front of the canal exit is comfortably > 0.4 mm nozzle line width and
// the slicer does not drop it (the previous 0.4 mm wall was EXACTLY the
// line width, on the threshold of being dropped). Canal extent = 0.6 mm
// radial (= CANAL_INNER_OFFSET - CANAL_OUTER_OFFSET = 1.4 - 0.8), wall = 0.8 mm.
const TAB_SLOT_WIDTH = 8.0;
const CANAL_TANGENT_WIDTH = TAB_SLOT_WIDTH;
const TAB_SLOT_HEIGHT = 1.0;
const TAB_SLOT_THRU_DEPTH = 1.55;
const CANAL_INNER_OFFSET = 1.4;  // canal inner R = apothem - 1.4 (= 8.4)
const CANAL_OUTER_OFFSET = 0.8;  // canal outer R = apothem - 0.8 (= 9.0; wall 0.8 mm)

// Nut pocket opens directly at the body bottom (flange-body junction) — no
// captive layer above it. The nut is dropped in from the wall side through
// the flange hex hole, sits in the pocket, and the bolt threaded in from the
// opposite side holds it in place. No print pause needed. Matches the
// original RostaP M3/M4/M5 insert reference.
const NUT_POCKET_OFFSET = 0;

// Note: the previous "wider hex bore above nut pocket" addition has been
// reverted. The user identified it as a wrong interpretation — the original
// M-nut variant doesn't have that hex bore; the body above the nut pocket
// stays solid except for the shaft hole.
// Shaft entrance chamfer constants removed: with the M-nut variant now using
// a hex hole through the flange (= same as empty) and the wall-mount/cluster
// countersunk using a proper 90° cone, no straight shaft enters the flange
// face anymore.

// Countersunk variant = pure wall-mount through-hole. NO nut pocket: the
// screw threads into a wall anchor on the far side of the panel; the captive
// nut feature belongs to the M-nut variants (m3/m4/m5) used to attach hooks
// or accessories. Geometry has 3 nested cavities, ordered USER → WALL along
// the screw axis (i.e. from FLANGE tip end to BODY tip end):
//   1. cylinder Ø headDiameter          (deep access well, USER/flange-tip side)
//   2. cone Ø headDiameter → Ø shaftDiameter  (short funnel where the head seats)
//   3. shaft Ø shaftDiameter            (WALL/body-tip side, narrow — exits into wall)
// Matches the original RostaP insert-countersung-m3.stl exactly (verified by
// measuring the STL: cavity Ø10 opens at the flange-tip face, Ø3.5 opens at
// the body-tip face). The user-facing side of the panel is the FLANGE side
// (flange caps protrude outward, visible to the user); the wall-facing side
// is the body-tip / rear-groove side. The screw is inserted from the user
// (flange) side and its shaft exits the body tip into the wall material.
// Sizes adapt per M-size: Ø_shaft and Ø_head come from SCREW_SPECS.
//
// Lengths measured on `Insert-countersunk.stl` (Z=0 = flange-tip face):
//   - Ø10 wide cylinder spans Z=0 .. 6   → 6.0 mm
//   - cone Ø10 → Ø3.5 spans     Z=6 .. 9.25 → 3.25 mm
//   - Ø3.5 narrow shaft spans   Z=9.25 .. 10 → 0.75 mm
// Total = 10 mm = flange (2.5 mm, fully protruding outside the panel — there
// is no pocket recess; the flange caps the panel's cell-hole chamfered edge)
// + body (7.5 mm inside the panel cell hole). The auto-computed shaft length
// picks up the residual 0.75 mm so we only need to encode the cyl + cone here.
const COUNTERSUNK_CONE_DEPTH = 3.25;  // funnel where the head rests
const COUNTERSUNK_CYL_DEPTH = 6.0;    // access well above the cone (dominates)

interface ScrewSpec {
  shaftDiameter: number;
  headDiameter: number;
  nutFlats: number;
  nutThickness: number;
}

// headDiameter is the COUNTERSUNK head pocket Ø (= screwdriver access well),
// matching the original RostaP insert-countersung-m3.stl. PDF page 6 lists
// Ø10 for M3; M4/M5 scaled proportionally while staying inside the inner
// bodyFlat (~19.6 mm = 22.6 mm hex Ø). It is intentionally LARGER than the
// screw head itself (DIN 7991 M3 head = Ø6) so a screwdriver / hex key has
// room to operate.
// nutFlats / nutThickness still match DIN 934 dimensions + clearance for the
// captive-nut variants (m3/m4/m5, non-countersunk).
const SCREW_SPECS: Record<"m3" | "m4" | "m5", ScrewSpec> = {
  m3: { shaftDiameter: 3.5, headDiameter: 10.0, nutFlats: 5.5 + 2 * NUT_CLEARANCE, nutThickness: 2.4 + NUT_CLEARANCE },
  m4: { shaftDiameter: 4.5, headDiameter: 12.0, nutFlats: 7.0 + 2 * NUT_CLEARANCE, nutThickness: 3.2 + NUT_CLEARANCE },
  m5: { shaftDiameter: 5.5, headDiameter: 14.0, nutFlats: 8.0 + 2 * NUT_CLEARANCE, nutThickness: 4.0 + NUT_CLEARANCE },
};

function variantThread(v: CellVariant): "m3" | "m4" | "m5" | null {
  if (v === "m3" || v === "countersunk-m3") return "m3";
  if (v === "m4" || v === "countersunk-m4") return "m4";
  if (v === "m5" || v === "countersunk-m5") return "m5";
  return null;
}

function isCountersunk(v: CellVariant): boolean {
  return v === "countersunk-m3" || v === "countersunk-m4" || v === "countersunk-m5";
}

function isNutVariant(v: CellVariant): boolean {
  return v === "m3" || v === "m4" || v === "m5";
}

function n(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`SCAD: non-finite value ${x}`);
  if (Number.isInteger(x)) return x.toString();
  return x.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * For each cell, decide which hex edges receive a locking tab.
 *
 * The original RostaP cluster inserts place a barbed tab + L svaso on EVERY
 * hex edge of every cell — including the inner edges that face OTHER cluster
 * cells. This is required for 100% conformity with the original design and
 * gives each cell a uniform appearance. Inner-edge tabs:
 *   - Fit physically: the 2.2 mm cluster gap accommodates two 0.5 mm tabs
 *     and a 1.8 mm panel wall (the wall is narrower at the rear groove area
 *     where the tabs actually engage)
 *   - Engage the panel cell's own rear groove (each panel cell has its own
 *     groove around its full perimeter, including the side facing the wall
 *     between cluster cells)
 *
 * Edge i (i=0..5) has outward-normal angle `(pointy ? 90 : 0) + (i + 0.5) * 60°`.
 */
function clusterTabEdges(
  _idx: number,
  _centers: Vec2[],
  _pitch: number,
  _pointy: boolean,
): number[] {
  return [0, 1, 2, 3, 4, 5];
}

interface BuildInsertScadArgs {
  centers: Vec2[];
  params: HswParams;
  insertParams: InsertParams;
  variants: CellVariant[];
  pitch: number;
}

/**
 * Generate SCAD for a 1..N-cell clip insert. Structure:
 *
 *   solid =
 *     flange_strip          (z=0..flangeHeight, hex per cell, overlapping → union)
 *     + body plugs          (z=flangeHeight..flangeHeight+bodyCleanH, one per cell)
 *     + tab section         (z=bodyTop..panelTop, body + tabs on free edges)
 *   cavities =
 *     per-cell flange opening (variant-specific: hex/circle/screw head pocket)
 *     + per-cell body cavity (hex/circle/shaft hole)
 *     + nut pocket (M-nut variants only)
 *   insert = solid - cavities
 */
function genClipInsertScad(args: BuildInsertScadArgs): string {
  const { centers, params, insertParams, variants, pitch } = args;
  const pointy = params.orientation === "pointy";
  const pointyLit = pointy ? "true" : "false";

  const bodyFlat = params.cellInnerWidth - 2 * insertParams.clipClearance;
  const flangeFlat = insertParams.flangeWidth;
  const flangeH = insertParams.flangeHeight;
  const tabZoneH =
    insertParams.tabFrontBevel + insertParams.tabPlateau + insertParams.tabRearBevel;
  // bodyCleanH = Z where the tab section starts. When `tabZStart` is set
  // explicitly (matches the original RostaP design — tabs in the middle of
  // the body), use that. Otherwise fall back to the legacy "tabs sit at the
  // body end" formula.
  const bodyCleanH =
    insertParams.tabZStart !== undefined
      ? insertParams.tabZStart
      : Math.max(0, insertParams.panelDepth - tabZoneH - insertParams.tipRecess);
  // Z convention: insert z=0 is the FLANGE-BODY INTERFACE, aligned with the
  // panel's z=0 (= front face / OUTER face). The flange protrudes its full
  // height (2.5 mm) OUTWARD on top of the panel; nothing is recessed inside
  // a "pocket" any more — the panel front face has only a 0.5 mm chamfer at
  // the cell-hole edge (pocketFlat 20.8 → frontFlat 20.0), and the 22.5 mm
  // flange is too wide to enter that chamfer. It caps the chamfered opening
  // from above, matching the original RostaP design. The body + tab section
  // extend from the panel front face (z=0) through the cell hole, snap-step
  // chamfer, and into the rear groove (z=0..totalInsertionH ≈ 0..7.5 mm).
  //
  // Viewer convention (matching): default rotation `+π/2` puts the flange face
  // (OUTER) up toward the camera; the rear-groove WALL face is down/hidden.
  // Toggling `flipped` swaps the rotation sign so the WALL face becomes visible.
  const flangeZ = -flangeH;
  const bodyTopZ = bodyCleanH;
  const tabTipZ = bodyCleanH + tabZoneH;
  // Body extends from z=0 up to (panelDepth - tipRecess). With tabZStart in
  // the body middle (matching RostaP), the body main continues PAST the tab
  // section before the tip chamfer. With tabZStart unset (legacy), the body
  // length equals tabZStart + tabZoneH (= legacy `bodyCleanH + tabZoneH`).
  const totalInsertionH = Math.max(
    bodyCleanH + tabZoneH,
    insertParams.panelDepth - insertParams.tipRecess,
  );
  const holeFlat = insertParams.innerHoleWidth;
  // Insert no longer seats in a pocket — the flange sits ON TOP of the panel
  // (z=0 in panel coords = bottom of the flange in insert coords). Kept as a
  // named constant in case a future variant wants partial recess.
  const POCKET_DEPTH = 0;

  const lines: string[] = [];
  lines.push(`$fn = ${DEFAULT_FN};`);
  lines.push(HSW_SCAD_LIBRARY);

  // --- Solids ---
  lines.push(`module solids() {`);

  // Body+flange constructed as 4 sections (chamfers on the outer perimeter
  // at the FLANGE FRONT and the BODY TIP, matching the original RostaP STL):
  //   z = flangeZ                       .. flangeZ + FLANGE_FRONT_CHAMFER  ─ flange front chamfer (flat 21.9 → 22.5)
  //   z = flangeZ + FLANGE_FRONT_CHAMFER .. 0                                 ─ flange main (flat 22.5)
  //   z = 0                              .. tipChamferStart                  ─ body clean + tab section body (flat 19.6)
  //   z = tipChamferStart                .. totalInsertionH                  ─ body tip chamfer (flat 19.6 → 19.3)
  const tipChamferStart = Math.max(0, totalInsertionH - BODY_TIP_CHAMFER_DEPTH);
  const flangeMainStart = flangeZ + FLANGE_FRONT_CHAMFER_DEPTH;
  for (let i = 0; i < centers.length; i++) {
    const [cx, cy] = centers[i];
    lines.push(`  translate([${n(cx)}, ${n(cy)}, ${n(POCKET_DEPTH)}]) {`);
    // Flange — chamfered front + main hex.
    lines.push(`    translate([0, 0, ${n(flangeZ)}]) hex_frustum(${n(flangeFlat - FLANGE_FRONT_CHAMFER_NARROW)}, ${n(flangeFlat)}, ${n(FLANGE_FRONT_CHAMFER_DEPTH)}, ${pointyLit});`);
    if (flangeH > FLANGE_FRONT_CHAMFER_DEPTH) {
      lines.push(`    translate([0, 0, ${n(flangeMainStart)}]) hex_prism(${n(flangeFlat)}, ${n(flangeH - FLANGE_FRONT_CHAMFER_DEPTH)}, ${pointyLit});`);
    }
    // Body + tab body section — combined into a single prism plus a frustum
    // at the very top for the body-tip chamfer.
    if (tipChamferStart > 0) {
      lines.push(`    hex_prism(${n(bodyFlat)}, ${n(tipChamferStart)}, ${pointyLit});`);
    }
    if (totalInsertionH > tipChamferStart) {
      lines.push(`    translate([0, 0, ${n(tipChamferStart)}]) hex_frustum(${n(bodyFlat)}, ${n(bodyFlat - BODY_TIP_CHAMFER_NARROW)}, ${n(totalInsertionH - tipChamferStart)}, ${pointyLit});`);
    }
    // Tabs sit in the tab zone, ending BEFORE the body-tip chamfer so they
    // don't bleed into the narrowing frustum (which would create a tab tip
    // overhanging the chamfered body — non-manifold).
    const tabEndZ = Math.min(bodyTopZ + tabZoneH, tipChamferStart);
    const tabActualZoneH = Math.max(0, tabEndZ - bodyTopZ);
    if (tabActualZoneH > 0) {
      const tabEdges = clusterTabEdges(i, centers, pitch, pointy);
      // Scale the bevel proportions so the barbed shape fits in the shorter
      // tab zone when the chamfer eats into it.
      const scale = tabActualZoneH / tabZoneH;
      const fb = insertParams.tabFrontBevel * scale;
      const pl = insertParams.tabPlateau * scale;
      const rb = insertParams.tabRearBevel * scale;
      for (const edge of tabEdges) {
        lines.push(
          `    tab_on_edge(${edge}, ${n(bodyFlat)}, ${n(insertParams.tabWidth)}, ${n(insertParams.tabProtrude)}, ${n(fb)}, ${n(pl)}, ${n(rb)}, ${n(bodyTopZ)}, ${pointyLit});`,
        );
      }
    }
    lines.push(`  }`);
  }

  // === Flange spines: connect adjacent cells of multi-cell inserts ===
  // The original RostaP cluster/bridge has a SINGLE continuous flange
  // spanning all cells. Lattice pitch (= cellInnerWidth + wallThickness,
  // 23.6 mm for HSW default) is 1.1 mm wider than the flange hex flat
  // (22.5 mm), so adjacent flange hexes don't touch — they leave a
  // visible gap that makes the insert read as N separate pieces.
  //
  // Fix: add a thin cube spanning each adjacent-cell pair, inside the
  // FLANGE PROTRUSION Z range only (world z = -flangeH+POCKET_DEPTH ..
  // 0, behind the panel) so the spine never collides with the panel's
  // inter-cell walls (which fill the pocket Z range world z=0..POCKET_DEPTH).
  //
  // Spine width = hex edge length (≈ flangeFlat / √3, ≈ 13.0 mm for
  // 22.5 mm flat) so it sits inside the shared edge of the two flange
  // hexes. Length = full centre-to-centre distance; the cube overlaps
  // deep into both flanges, giving CSG union a wide tolerance.
  if (centers.length > 1) {
    const adjThreshold = pitch * 1.05; // catches all 6 nearest neighbors
    const spineWidth = flangeFlat / Math.sqrt(3);
    const spineH = flangeH - POCKET_DEPTH; // local Z range = [flangeZ, -POCKET_DEPTH]
    const spineCenterZLocal = flangeZ + spineH / 2;
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const dx = centers[j][0] - centers[i][0];
        const dy = centers[j][1] - centers[i][1];
        const dist = Math.hypot(dx, dy);
        if (dist > adjThreshold) continue;
        const midX = (centers[i][0] + centers[j][0]) / 2;
        const midY = (centers[i][1] + centers[j][1]) / 2;
        const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        lines.push(
          `  translate([${n(midX)}, ${n(midY)}, ${n(POCKET_DEPTH + spineCenterZLocal)}]) rotate([0, 0, ${n(angleDeg)}]) cube([${n(dist)}, ${n(spineWidth)}, ${n(spineH)}], center=true);`,
        );
      }
    }
  }

  lines.push(`}`);

  // --- Cavities ---
  // Includes per-cell variant features (hole/shaft/nut) AND the universal
  // tool-pry removal grooves on both faces (carved into every clip cell).
  lines.push(`module cavities() {`);
  for (let i = 0; i < centers.length; i++) {
    const [cx, cy] = centers[i];
    const variant = variants[i];

    const cavityLines: string[] = [];

    // Tab-relief L at each edge midpoint (matches original RostaP visually).
    // Slot cuts radially through the body wall via tab_relief_slot; canal
    // rises from slot bottom to body tip face as a tangent-aligned cube.
    {
      const slotZ = bodyTopZ - TAB_SLOT_HEIGHT;
      const slotEdges = slotZ > 0 ? clusterTabEdges(i, centers, pitch, pointy) : [];
      const canalRInner = bodyFlat / 2 - CANAL_INNER_OFFSET;
      const canalROuter = bodyFlat / 2 - CANAL_OUTER_OFFSET;
      const canalZBottom = slotZ;
      const canalZTop = totalInsertionH;
      for (const edge of slotEdges) {
        cavityLines.push(
          `    tab_relief_slot(${edge}, ${n(bodyFlat)}, ${n(TAB_SLOT_WIDTH)}, ${n(TAB_SLOT_HEIGHT)}, ${n(TAB_SLOT_THRU_DEPTH)}, ${n(slotZ)}, ${pointyLit});`,
        );
        if (canalZTop > canalZBottom && canalROuter > canalRInner) {
          cavityLines.push(
            `    rotate([0, 0, hex_edge_angle(${edge}, ${pointyLit})]) translate([${n(canalRInner)}, ${n(-CANAL_TANGENT_WIDTH / 2)}, ${n(canalZBottom - 0.05)}]) cube([${n(canalROuter - canalRInner)}, ${n(CANAL_TANGENT_WIDTH)}, ${n(canalZTop - canalZBottom + 1.05)}]);`,
          );
        }
      }
    }

    if (variant !== "solid") {
      // Flange feature (cavity carved through the flange at z=flangeZ..0).
      if (variant === "empty" && holeFlat > 0) {
        cavityLines.push(`    translate([0, 0, ${n(flangeZ - 0.05)}]) hex_prism_rounded(${n(holeFlat)}, ${n(flangeH + 0.1)}, 0.1, ${pointyLit});`);
      } else if (variant === "hollow") {
        cavityLines.push(`    translate([0, 0, ${n(flangeZ - 0.05)}]) cylinder(h=${n(flangeH + 0.1)}, r=${n(HOLLOW_DIAMETER / 2)}, $fn=${DEFAULT_FN});`);
      } else if (isCountersunk(variant)) {
        // Countersunk cavity is generated entirely in the body section below
        // (cyl + cone + shaft, spanning flange and body in one block).
        // Flange section here is a no-op for this variant.
      } else if (isNutVariant(variant) && holeFlat > 0) {
        // M-nut variant flange: hex hole (same opening as the empty variant)
        // so the nut pocket inside the body is VISIBLE / accessible from the
        // wall side. The user drops the captive nut in here during print
        // pause, then the body section seals it in place. Matches the original
        // RostaP M3/M4/M5 insert geometry (stepped hex pyramid visible from
        // the flange face: outer flange hex → flange hex hole → nut pocket →
        // shaft hole).
        cavityLines.push(`    translate([0, 0, ${n(flangeZ - 0.05)}]) hex_prism_rounded(${n(holeFlat)}, ${n(flangeH + 0.1)}, 0.1, ${pointyLit});`);
      }

      // Body + tab cavity (carved at z=0..totalInsertionH).
      if (isNutVariant(variant)) {
        const t = variantThread(variant)!;
        const shaftR = SCREW_SPECS[t].shaftDiameter / 2;
        cavityLines.push(`    translate([0, 0, -0.05]) cylinder(h=${n(totalInsertionH + 0.1)}, r=${n(shaftR)}, $fn=${DEFAULT_FN});`);
        // Nut pocket at the FLANGE END of the body (NUT_POCKET_OFFSET into
        // the body). The bolt threads into the nut here. Above the pocket the
        // body stays solid except for the shaft hole — NO wider hex bore
        // (the previous addition was a wrong interpretation of the original).
        const nutThickness = Math.min(
          SCREW_SPECS[t].nutThickness,
          Math.max(0, bodyCleanH - NUT_POCKET_OFFSET),
        );
        if (nutThickness > 0) {
          cavityLines.push(`    translate([0, 0, ${n(NUT_POCKET_OFFSET)}]) hex_prism(${n(SCREW_SPECS[t].nutFlats)}, ${n(nutThickness)}, ${pointyLit});`);
        }
      } else if (variant === "empty" && holeFlat > 0 && totalInsertionH > 0) {
        cavityLines.push(`    translate([0, 0, -0.05]) hex_prism_rounded(${n(holeFlat)}, ${n(totalInsertionH + 0.1)}, 0.1, ${pointyLit});`);
      } else if (variant === "hollow" && totalInsertionH > 0) {
        cavityLines.push(`    translate([0, 0, -0.05]) cylinder(h=${n(totalInsertionH + 0.1)}, r=${n(HOLLOW_DIAMETER / 2)}, $fn=${DEFAULT_FN});`);
      } else if (isCountersunk(variant) && totalInsertionH > 0) {
        const t = variantThread(variant)!;
        const shR = SCREW_SPECS[t].shaftDiameter / 2;
        const headR = SCREW_SPECS[t].headDiameter / 2;
        // 3-level cavity, ordered along z from FLANGE TIP (user side) to BODY
        // TIP (wall side). The user inserts the screwdriver into the wide
        // access well on the flange side; the screw head seats in the cone;
        // the narrow shaft exits the body tip into the wall behind the panel.
        const cylTopZ = flangeZ + COUNTERSUNK_CYL_DEPTH; // cyl ends here, cone starts
        const coneTopZ = cylTopZ + COUNTERSUNK_CONE_DEPTH; // cone ends, shaft begins
        const shaftLen = Math.max(0, totalInsertionH - coneTopZ) + 0.05;
        cavityLines.push(`    translate([0, 0, ${n(flangeZ - 0.05)}]) cylinder(h=${n(COUNTERSUNK_CYL_DEPTH + 0.05)}, r=${n(headR)}, $fn=${DEFAULT_FN});`);
        cavityLines.push(`    translate([0, 0, ${n(cylTopZ)}]) cylinder(h=${n(COUNTERSUNK_CONE_DEPTH)}, r1=${n(headR)}, r2=${n(shR)}, $fn=${DEFAULT_FN});`);
        cavityLines.push(`    translate([0, 0, ${n(coneTopZ)}]) cylinder(h=${n(shaftLen)}, r=${n(shR)}, $fn=${DEFAULT_FN});`);
      }
    }

    if (cavityLines.length === 0) continue;
    lines.push(`  translate([${n(cx)}, ${n(cy)}, ${n(POCKET_DEPTH)}]) {`);
    lines.push(...cavityLines);
    lines.push(`  }`);
  }
  lines.push(`}`);

  lines.push(`difference() { solids(); cavities(); }`);
  // Silence the unused-binding lint when no clusters need a body-tip Z.
  void tabTipZ;
  return lines.join("\n");
}

export function genInsertScad(
  centers: Vec2[],
  params: HswParams,
  insertParams: InsertParams,
  variants: CellVariant[],
  pitch: number,
): string {
  return genClipInsertScad({ centers, params, insertParams, variants, pitch });
}

/**
 * Wall-mount insert: single cell with countersunk head pocket on the flange
 * and a straight shaft hole through body + tab zone.
 */
export function genWallMountScad(
  center: Vec2,
  params: HswParams,
  wallParams: WallMountParams,
): string {
  const pointy = params.orientation === "pointy";
  const pointyLit = pointy ? "true" : "false";

  const bodyFlat = params.cellInnerWidth - 2 * wallParams.clipClearance;
  const flangeFlat = wallParams.flangeWidth;
  const flangeH = wallParams.flangeHeight;
  const tabZoneH =
    wallParams.tabFrontBevel + wallParams.tabPlateau + wallParams.tabRearBevel;
  const bodyCleanH =
    wallParams.tabZStart !== undefined
      ? wallParams.tabZStart
      : Math.max(0, wallParams.panelDepth - tabZoneH - wallParams.tipRecess);
  // Same Z convention as the clip insert: z=0 is the flange-body interface
  // (panel pocket bottom), flange sits at z=-flangeH..0 (protrudes OUTSIDE the
  // panel toward the OUTER / user face), body+tab live at z=0..totalInsertionH
  // inside the panel cell with the body tip against the WALL.
  const flangeZ = -flangeH;
  const bodyTopZ = bodyCleanH;
  const totalInsertionH = Math.max(
    bodyCleanH + tabZoneH,
    wallParams.panelDepth - wallParams.tipRecess,
  );
  const shaftR = wallParams.screwHoleDiameter / 2;
  const headR = wallParams.screwHeadDiameter / 2;

  const [cx, cy] = center;
  const tipChamferStart = Math.max(0, totalInsertionH - BODY_TIP_CHAMFER_DEPTH);
  const flangeMainStart = flangeZ + FLANGE_FRONT_CHAMFER_DEPTH;
  // Wall mount sits on top of the panel (no pocket recess) — same Z convention
  // as genClipInsertScad's POCKET_DEPTH=0.
  const POCKET_DEPTH = 0;
  const lines: string[] = [];
  lines.push(`$fn = ${DEFAULT_FN};`);
  lines.push(HSW_SCAD_LIBRARY);
  lines.push(`module solids() {`);
  lines.push(`  translate([${n(cx)}, ${n(cy)}, ${n(POCKET_DEPTH)}]) {`);
  // Flange: chamfered front + main hex (matches original RostaP).
  lines.push(`    translate([0, 0, ${n(flangeZ)}]) hex_frustum(${n(flangeFlat - FLANGE_FRONT_CHAMFER_NARROW)}, ${n(flangeFlat)}, ${n(FLANGE_FRONT_CHAMFER_DEPTH)}, ${pointyLit});`);
  if (flangeH > FLANGE_FRONT_CHAMFER_DEPTH) {
    lines.push(`    translate([0, 0, ${n(flangeMainStart)}]) hex_prism(${n(flangeFlat)}, ${n(flangeH - FLANGE_FRONT_CHAMFER_DEPTH)}, ${pointyLit});`);
  }
  // Body main + tip chamfer.
  if (tipChamferStart > 0) {
    lines.push(`    hex_prism(${n(bodyFlat)}, ${n(tipChamferStart)}, ${pointyLit});`);
  }
  if (totalInsertionH > tipChamferStart) {
    lines.push(`    translate([0, 0, ${n(tipChamferStart)}]) hex_frustum(${n(bodyFlat)}, ${n(bodyFlat - BODY_TIP_CHAMFER_NARROW)}, ${n(totalInsertionH - tipChamferStart)}, ${pointyLit});`);
  }
  // Tabs end BEFORE the body tip chamfer (matching original z=7.5..9.6 vs
  // body tip chamfer at z=9.6..10).
  if (tabZoneH > 0) {
    const tabEndZ = Math.min(bodyTopZ + tabZoneH, tipChamferStart);
    const tabActualZoneH = Math.max(0, tabEndZ - bodyTopZ);
    if (tabActualZoneH > 0) {
      const scale = tabActualZoneH / tabZoneH;
      const fb = wallParams.tabFrontBevel * scale;
      const pl = wallParams.tabPlateau * scale;
      const rb = wallParams.tabRearBevel * scale;
      for (const edge of wallParams.tabEdges) {
        lines.push(
          `    tab_on_edge(${edge}, ${n(bodyFlat)}, ${n(wallParams.tabWidth)}, ${n(wallParams.tabProtrude)}, ${n(fb)}, ${n(pl)}, ${n(rb)}, ${n(bodyTopZ)}, ${pointyLit});`,
        );
      }
    }
  }
  lines.push(`  }`);
  lines.push(`}`);

  lines.push(`module cavities() {`);
  lines.push(`  translate([${n(cx)}, ${n(cy)}, ${n(POCKET_DEPTH)}]) {`);
  // Tab-relief L at each edge midpoint (same as clip insert).
  {
    const slotZ = bodyTopZ - TAB_SLOT_HEIGHT;
    const canalRInner = bodyFlat / 2 - CANAL_INNER_OFFSET;
    const canalROuter = bodyFlat / 2 - CANAL_OUTER_OFFSET;
    const canalZBottom = slotZ;
    const canalZTop = totalInsertionH;
    if (slotZ > 0) {
      for (const edge of wallParams.tabEdges) {
        lines.push(
          `    tab_relief_slot(${edge}, ${n(bodyFlat)}, ${n(TAB_SLOT_WIDTH)}, ${n(TAB_SLOT_HEIGHT)}, ${n(TAB_SLOT_THRU_DEPTH)}, ${n(slotZ)}, ${pointyLit});`,
        );
        if (canalZTop > canalZBottom && canalROuter > canalRInner) {
          lines.push(
            `    rotate([0, 0, hex_edge_angle(${edge}, ${pointyLit})]) translate([${n(canalRInner)}, ${n(-CANAL_TANGENT_WIDTH / 2)}, ${n(canalZBottom - 0.05)}]) cube([${n(canalROuter - canalRInner)}, ${n(CANAL_TANGENT_WIDTH)}, ${n(canalZTop - canalZBottom + 1.05)}]);`,
          );
        }
      }
    }
  }
  // 3-level cavity matching the original RostaP — see comment on
  // COUNTERSUNK_*_DEPTH constants for the FLANGE-TIP (user) → BODY-TIP (wall)
  // ordering of the levels.
  const cylTopZ = flangeZ + COUNTERSUNK_CYL_DEPTH;
  const coneTopZ = cylTopZ + COUNTERSUNK_CONE_DEPTH;
  const shaftLen = Math.max(0, totalInsertionH - coneTopZ) + 0.05;
  lines.push(`    translate([0, 0, ${n(flangeZ - 0.05)}]) cylinder(h=${n(COUNTERSUNK_CYL_DEPTH + 0.05)}, r=${n(headR)}, $fn=${DEFAULT_FN});`);
  lines.push(`    translate([0, 0, ${n(cylTopZ)}]) cylinder(h=${n(COUNTERSUNK_CONE_DEPTH)}, r1=${n(headR)}, r2=${n(shaftR)}, $fn=${DEFAULT_FN});`);
  lines.push(`    translate([0, 0, ${n(coneTopZ)}]) cylinder(h=${n(shaftLen)}, r=${n(shaftR)}, $fn=${DEFAULT_FN});`);
  lines.push(`  }`);
  lines.push(`}`);

  lines.push(`difference() { solids(); cavities(); }`);
  return lines.join("\n");
}
