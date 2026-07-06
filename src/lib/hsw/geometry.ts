import type { BorderOptions, HswParams, Mesh, Polygon } from "@/types";
import { DEFAULT_SNAP_STEP, type SnapStepSpec } from "@/lib/hsw/constants";
import {
  cellsHexBbox,
  generateCells,
  traceBorderlessOutline,
} from "@/lib/hsw/honeycomb";
import { runOpenScad } from "@/lib/openscad/openscadClient";
import { genTileScad, type PanelCell } from "@/lib/openscad/scad/panel";

type CellLike = PanelCell;

/**
 * Build the mesh for a single tile from its pre-computed outline and cell set.
 *
 * Backed by OpenSCAD (CGAL CSG) running in WASM: the panel solid is the
 * outline extruded to full depth, then per-cell stepped columns are subtracted.
 * The result is always a clean 2-manifold, faithful to the RostaP HSW spec
 * apart from `rearFlat` capped at `pitch - 0.01 mm` (CGAL non-manifold guard).
 */
export async function buildTileMesh(
  outline: Polygon,
  cells: CellLike[],
  params: HswParams,
  snapStep: SnapStepSpec = DEFAULT_SNAP_STEP,
): Promise<Mesh> {
  const scad = genTileScad(outline, cells, params, snapStep);
  return runOpenScad(scad);
}

/** Build the full honeycomb panel mesh for an outline + border options. */
export async function buildPanelMesh(
  outline: Polygon,
  params: HswParams,
  border: BorderOptions,
  snapStep: SnapStepSpec = DEFAULT_SNAP_STEP,
): Promise<Mesh> {
  const clearance = border.enabled ? border.thickness : params.wallThickness / 2;
  const cells = generateCells(outline, params, clearance);
  if (cells.length === 0) {
    return buildTileMesh(outline, [], params, snapStep);
  }

  // When a closed frame seals the panel, clipped half-cells become hooks for
  // nothing — straight extrusion is enough. When the panel is borderless (=
  // open edges), clipped half-cells should keep the full snap-step profile so
  // the user can butt another panel against this edge later and host inserts
  // across the joint.
  const clipNoSnap = border.enabled;
  const panelCells: CellLike[] = cells.map((c) =>
    c.clipped ? { center: c.center, clipped: c.clipped, clipNoSnap } : { center: c.center },
  );

  let panelOutline: Polygon;
  if (border.enabled) {
    const bbox = cellsHexBbox(cells, params);
    const t = border.thickness;
    panelOutline = [
      [bbox.min[0] - t, bbox.min[1] - t],
      [bbox.max[0] + t, bbox.min[1] - t],
      [bbox.max[0] + t, bbox.max[1] + t],
      [bbox.min[0] - t, bbox.max[1] + t],
    ];
  } else {
    panelOutline = traceBorderlessOutline(cells, params);
    if (panelOutline.length === 0) panelOutline = outline;
  }
  return buildTileMesh(panelOutline, panelCells, params, snapStep);
}
