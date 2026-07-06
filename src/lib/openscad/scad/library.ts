/**
 * Shared OpenSCAD library prepended to every render. Defines modules and
 * functions used by the panel / insert generators. Keeping it as a single
 * string (rather than a file the WASM FS has to read) avoids round-trips
 * through the virtual filesystem.
 *
 * Conventions:
 *  - Hex cells are flat-top by default (`pointy=false`), matching the HSW
 *    standard. Pointy-top rotates the whole hex by 90°.
 *  - All length units are millimetres. Z is the panel depth direction.
 *  - Modules built at the origin are translated into place by the caller.
 *  - `$fn` is left to the caller via the generated main code.
 */
export const HSW_SCAD_LIBRARY = String.raw`
function hex_r_from_flat(flat) = flat / sqrt(3);

// Outward-normal angle of hex edge idx (0..5).
//  flat-top (pointy=false): corners at 0,60,120,... -> edge i normal at (i+0.5)*60.
//  pointy-top (pointy=true): corners at 90,150,... -> edge i normal at 90+(i+0.5)*60.
function hex_edge_angle(idx, pointy=false) = (pointy ? 90 : 0) + (idx + 0.5) * 60;

// Flat-top hex prism (corners along +x). Set pointy=true to put a corner on +y.
module hex_prism(flat, h, pointy=false) {
  rotate([0, 0, pointy ? 90 : 0])
    cylinder(h=h, r=hex_r_from_flat(flat), $fn=6);
}

// Hex prism with slightly rounded corners (fillet radius r). Used for the
// inner hex hole subtraction in cluster inserts to avoid a Manifold CSG
// precision artifact (extra ~0.05 mm vertices at sharp hex corners when
// adjacent cube cuts come close). Net flat-to-flat size unchanged: the
// offset(r) then offset(-r) pair rounds convex hex corners without changing
// the overall hex dimensions.
module hex_prism_rounded(flat, h, r=0.1, pointy=false) {
  rotate([0, 0, pointy ? 90 : 0])
    linear_extrude(height=h, convexity=4)
      offset(r=r, $fn=16)
        offset(r=-r, $fn=16)
          circle(r=hex_r_from_flat(flat), $fn=6);
}

// Hex frustum: linearly tapered hexagonal prism from flat_bottom to flat_top.
// Used to cut the snap-step chamfer inside each cell hole.
module hex_frustum(flat_bottom, flat_top, h, pointy=false) {
  rotate([0, 0, pointy ? 90 : 0])
    cylinder(h=h, r1=hex_r_from_flat(flat_bottom), r2=hex_r_from_flat(flat_top), $fn=6);
}

// Stepped hex hole carved into a panel (z=0 front, z=depth rear).
//   z=-EPS .. pocket_depth   linear taper pocket_flat -> front_flat (front edge chamfer)
//   pocket_depth .. step_start    front_flat                       (narrow front section)
//   step_start .. step_end  linear taper front_flat -> rear_flat   (rear snap chamfer)
//   step_end .. depth+EPS   rear_flat                              (rear snap groove)
// The front edge chamfer matches the original RostaP panel: at z=0 the hole
// opens to pocket_flat (≈ 20.8 mm), tapering down to front_flat (20 mm) at
// z=pocket_depth (= 0.5 mm). It's a slight inclination, not a wider pocket
// for the flange to seat into — in the original design the insert flange
// (22.5 mm) sits OUTSIDE the panel front face, on top of the cell-hole
// chamfered edge. Pass pocket_depth=0 (or pocket_flat ≤ front_flat) to skip.
// If step_end - step_start is at most 1e-3, the rear chamfer is skipped and
// the step becomes instantaneous (legacy CGAL workaround, kept for the type
// signature though Manifold no longer needs it).
module stepped_hex_hole(front_flat, rear_flat, step_start, step_end, depth, pocket_flat=0, pocket_depth=0, pointy=false) {
  EPS = 0.05;
  has_chamfer = (step_end - step_start) > 1e-3;
  has_front_chamfer = (pocket_depth > 1e-3) && (pocket_flat > front_flat);
  if (has_front_chamfer) {
    translate([0, 0, -EPS])
      hex_frustum(pocket_flat, front_flat, pocket_depth + EPS, pointy);
    translate([0, 0, pocket_depth])
      hex_prism(front_flat, step_start - pocket_depth, pointy);
  } else {
    translate([0, 0, -EPS])
      hex_prism(front_flat, step_start + EPS, pointy);
  }
  if (has_chamfer) {
    translate([0, 0, step_start])
      hex_frustum(front_flat, rear_flat, step_end - step_start, pointy);
    translate([0, 0, step_end])
      hex_prism(rear_flat, depth - step_end + EPS, pointy);
  } else {
    translate([0, 0, step_start])
      hex_prism(rear_flat, depth - step_start + EPS, pointy);
  }
}

// Straight-through hex hole (no snap step).
module straight_hex_hole(flat, depth, pointy=false) {
  EPS = 0.05;
  translate([0, 0, -EPS])
    hex_prism(flat, depth + 2 * EPS, pointy);
}

// Single barbed locking tab. Protrudes in +x from a flat at x=0; width runs
// along y centred on the origin; height along z (tab base at z=0).
//
// Profile is the EXACT 2D polygon extracted from the original RostaP
// Insert-countersunk.stl by scripts/extract-tab-polygon-v2.ts (y=0 mesh
// slice through edge-midpoint at theta=30°, walked as a closed polyline,
// NO RESAMPLING — every mesh vertex on the slice is preserved). fb/pl/rb
// parameters from the caller are IGNORED — the polygon embeds the original
// curve exactly. They are kept on the signature for API stability with
// callers that still pass them.
//
// The first and last polygon points have x = -EMBED so the tab base embeds
// into the body wall for a clean CSG union (no coincident face). The polygon
// is oriented CCW: base-embed -> outer silhouette (rising x) -> top-embed,
// closed implicitly by polygon().
//
// The polygon's x values are scaled by (protrude / POLY_PEAK) so callers can
// shrink/enlarge the radial protrusion proportionally; the z extent is fixed
// at the original 2.10 mm and is NOT scaled. This Z extent includes the
// snap-catch shelf tail (the kink at z_local ≈ 1.67 mm with prot ≈ 0.17 mm)
// that engages the panel rear groove — a functional feature missed by the
// v1 extraction (which truncated at z_local = 1.24 mm).
module barbed_tab(width, protrude, fb, pl, rb) {
  // Peak protrusion in the source polygon (mm). Used as the scale base.
  POLY_PEAK = 0.4782;
  POLY_RAW = [
    [-0.05, 0],
    [0, 0],
    [0.02894, 0.05282],
    [0.10289, 0.10563],
    [0.17104, 0.16556],
    [0.2392, 0.22549],
    [0.29394, 0.29788],
    [0.34869, 0.37027],
    [0.38779, 0.45217],
    [0.4269, 0.53407],
    [0.44878, 0.62215],
    [0.47066, 0.71023],
    [0.47442, 0.80092],
    [0.47817, 0.89159],
    [0.46366, 0.98119],
    [0.44914, 1.07077],
    [0.41695, 1.15563],
    [0.38475, 1.24049],
    [0.16988, 1.67024],
    [0, 2.1],
    [-0.05, 2.1],
  ];
  scale_x = protrude / POLY_PEAK;
  POLY = [for (p = POLY_RAW) [p[0] * scale_x, p[1]]];
  // The polygon lives in the XZ plane: we draw it as a 2D shape (X=protrusion,
  // Y=tab height), linear_extrude along its local Z to give the tab width,
  // then rotate 90° about X so that local-Z becomes world-Y (tangent) and the
  // polygon's local-Y becomes world-Z (tab height).
  rotate([90, 0, 0])
    linear_extrude(height = width, center = true)
      polygon(POLY);
}

// Place a barbed tab on hex edge edge_idx, centred on its midpoint, normal
// pointing outward. body_flat is the hex flat-to-flat (the tab base sits
// flush with the body's flat face).
module tab_on_edge(edge_idx, body_flat, width, protrude, fb, pl, rb, z_base, pointy=false) {
  angle = hex_edge_angle(edge_idx, pointy);
  r_edge = body_flat / 2;
  translate([0, 0, z_base])
    rotate([0, 0, angle])
      translate([r_edge, 0, 0])
        barbed_tab(width, protrude, fb, pl, rb);
}

// Tab-relief through-cut slot on hex edge edge_idx. Carves a rectangular
// box through the body wall just below the locking tab, creating the
// cantilever beam that lets the tab flex inward when the user removes the
// insert. Measured from the original RostaP insert-empty.stl: 8 mm wide
// (tangent), 1 mm tall (Z), through-cut radially. Centred on the edge
// midpoint in tangent direction.
//
// Caller is responsible for placing this inside a difference() against the
// solid body; the module emits the volume to SUBTRACT.
//
//   edge_idx: hex edge index (0..5)
//   body_flat: hex body flat-to-flat (mm)
//   width: tangent extent along the edge (mm)
//   height: Z extent (mm)
//   thru: radial cut depth from the outer face inward (mm); should exceed
//         half the body diameter for a clean through-cut on any cavity geometry
//   z_base: slot bottom z (mm)
module tab_relief_slot(edge_idx, body_flat, width, height, thru, z_base, pointy=false) {
  EPS = 0.05;
  angle = hex_edge_angle(edge_idx, pointy);
  r_edge = body_flat / 2;
  translate([0, 0, z_base - EPS])
    rotate([0, 0, angle])
      translate([r_edge - thru, -width / 2, 0])
        cube([thru + EPS, width, height + 2 * EPS]);
}

`;
