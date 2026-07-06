export type Vec2 = readonly [number, number];

export type Polygon = Vec2[];

export interface HswParams {
  /** Inner flat-to-flat width of a hexagonal hole (mm). */
  cellInnerWidth: number;
  /** Wall thickness between adjacent cells (mm). */
  wallThickness: number;
  /** Panel depth / extrusion height (mm). */
  depth: number;
  /** Hexagon orientation. The original HSW is pointy-top. */
  orientation: "pointy" | "flat";
  /**
   * Per-side radial expansion applied to the panel cell hole (mm) to compensate
   * for print-material shrinkage / over-extrusion. Adds `2 * cellHoleExpansion`
   * to front_flat, rear_flat and pocket_flat when generating the panel SCAD.
   *
   * Reference values (see MATERIAL_PROFILES in constants.ts):
   *   PETG:  0     mm  (RostaP baseline — original inserts fit at nominal 20 mm)
   *   PLA:   0.15  mm  (compensates typical PLA over-extrusion ~0.15 mm/side)
   *   ABS:  -0.05  mm  (slight negative comp for ABS thermal contraction)
   *
   * When both panel and insert are printed in the SAME material both shrink
   * together and no compensation is needed (leave 0). Use non-zero only when
   * mixing materials (e.g. PLA panel + PETG-original insert) or when your
   * printer is known to over/under-extrude.
   *
   * Defaults to 0 when unset.
   */
  cellHoleExpansion?: number;
}

/** Named material profiles that set a preset `cellHoleExpansion`. */
export type MaterialProfile = "PETG" | "PLA" | "ABS" | "custom";

export interface PlateSpec {
  id: string;
  label: string;
  /** Usable bed size (mm). */
  width: number;
  height: number;
}

/** A rectangle placement on a bed: result of bin-packing. */
export interface PlacedItem {
  id: string;
  /** Width/height of the item (possibly swapped if rotated). */
  width: number;
  height: number;
  /** Lower-left corner of the item in bed coordinates (mm). */
  x: number;
  y: number;
  /** True when the packer rotated the item 90° to fit. */
  rotated: boolean;
}

/** Single print plate filled by the packer. */
export interface PackedBed {
  index: number;
  plate: PlateSpec;
  margin: number;
  items: PlacedItem[];
}

export interface WallSpec {
  /** Outline polygon in mm, counter-clockwise, origin at (0,0). */
  outline: Polygon;
  params: HswParams;
  border: BorderOptions;
}

export interface BorderOptions {
  /** When true the outline is the user shape; when false the panel edge follows the honeycomb cells. */
  enabled: boolean;
  /** Distance from the outermost hole to the outline (mm). Used only when `enabled`. */
  thickness: number;
}

/** A triangle mesh in millimetres. */
export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface HexCell {
  /** Centre of the hexagon in mm. */
  center: Vec2;
  /** Axial column index. */
  col: number;
  /** Axial row index. */
  row: number;
  /**
   * When the cell's hexagon is clipped by the wall outer border, this is the
   * truncated polygon to use as the hole (instead of the full hex). Set only
   * for cells along the wall border in clipped-bordered mode; full cells leave
   * this undefined. Clipped cells are NOT eligible for clip / bridge / mount
   * inserts because they have less than a full cell wall around the body.
   */
  clipped?: Polygon;
}

export interface TileSpec {
  id: string;
  /** Indices into the global cell array this tile owns. */
  cellIndices: number[];
  cells: HexCell[];
  /** Tile outline polygon (zig-zag honeycomb boundary). */
  outline: Polygon;
  bbox: { min: Vec2; max: Vec2; width: number; height: number };
}

export type InsertKind = "clip" | "wallMount";

export interface InsertSpec {
  id: string;
  /** "clip" = bridges two tiles across a seam; "wallMount" = screws the panel to a wall. */
  kind: InsertKind;
  /** Cell centres the insert plugs into. Clip inserts span 1..6 cells; wall mounts are single-cell. */
  centers: Vec2[];
  /** Tile this insert lives in (the cells' owning tile). */
  tileId: string;
  /** Clip inserts only: the tile on the other side of the seam. */
  pairsWith?: string;
  /**
   * Indices into `centers` that double as a wall mount (set by
   * mergeWallMountsIntoClips). These cells use the global wall-mount variant
   * (default countersunk-M3) unless the user has overridden them per-cell.
   */
  mountIndices?: number[];
}
