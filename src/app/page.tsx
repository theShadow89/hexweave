"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import styles from "./page.module.css";
import type { ColoredMesh } from "@/components/Viewer/Viewer";
import {
  DEFAULT_PRINT_WALL_COLOR,
  DEFAULT_PRINT_INSERT_COLOR,
} from "@/components/Viewer/Viewer";
import {
  ShapeInput,
  DEFAULT_SHAPE_STATE,
  type ShapeState,
} from "@/components/ShapeInput/ShapeInput";
import { AgentPanel } from "@/components/Agent/AgentPanel";
import {
  CUSTOM_PLATE_ID,
  DEFAULT_BORDER,
  DEFAULT_PLATE_MARGIN,
  HSW_STANDARD,
  MATERIAL_PROFILES,
  PLATE_PRESETS,
  materialProfileFromExpansion,
} from "@/lib/hsw/constants";
import type { MaterialProfile } from "@/types";
import { parseVerticesText, rectangleOutline } from "@/lib/shape/polygon";
import { regularPolygon } from "@/lib/shape/fromSides";
import { polygonsFromSvg } from "@/lib/shape/fromSvg";
import { generateCells, traceBorderlessOutline } from "@/lib/hsw/honeycomb";
import { buildTileMesh } from "@/lib/hsw/geometry";
import {
  ALL_CELL_VARIANTS,
  buildInsertMesh,
  CELL_VARIANT_LABELS,
  type CellVariant,
} from "@/lib/hsw/insert";
import { subdivideWall, tilesFitPlate } from "@/lib/subdivision/tiler";
import {
  clipFullCellKeys,
  mergeWallMountsIntoClips,
  placeBridgeInserts,
  placeSeamInserts,
  placeWallMountInserts,
} from "@/lib/subdivision/inserts";
import { packBeds } from "@/lib/subdivision/packer";
import {
  downloadStl,
  downloadStlZip,
  downloadThreeMfZip,
} from "@/lib/export/download";
import { buildAssemblyMap, assemblyMapToReadme } from "@/lib/export/assembly";
import { meshBounds3, recenterToOrigin, rotate90Z } from "@/lib/three/meshOps";
import { prewarmOpenScad } from "@/lib/openscad/openscadClient";
import type { InsertSpec, Mesh, PlateSpec, Polygon } from "@/types";

const Viewer = dynamic(() => import("@/components/Viewer/Viewer"), { ssr: false });

const TILE_COLORS = ["#4b6bfb", "#5fd08a", "#c95edb", "#3aa9c9", "#e76f51", "#a78bfa"];
// Three distinct accent colours for the three insert categories so a glance
// at the viewer in `colors` mode reads each piece's role:
//   clip   = orange       (vertical seam inserts)
//   bridge = warm yellow  (horizontal seam bridges)
//   mount  = vibrant red  (wall mounts)
const CLIP_INSERT_COLOR = "#f0a04b";
const BRIDGE_INSERT_COLOR = "#f4d35e";
const WALL_MOUNT_COLOR = "#e63946";

function computePolygon(state: ShapeState): Polygon {
  switch (state.mode) {
    case "rectangle":
      return rectangleOutline(state.rectangle.width, state.rectangle.height);
    case "sides":
      return regularPolygon(state.sides.count, state.sides.length);
    case "vertices":
      return parseVerticesText(state.vertices.text);
    case "svg": {
      const polys = polygonsFromSvg(state.svg.text);
      return polys[state.svg.selected] ?? [];
    }
    case "draw":
      return state.draw.points;
  }
}

interface TileEntry {
  id: string;
  mesh: Mesh;
  color: string;
  bbox: { width: number; height: number; min: [number, number] };
  cells: number;
}
interface InsertEntry {
  id: string;
  spec: InsertSpec;
  variants: CellVariant[];
  mesh: Mesh;
  cellCount: number;
}
interface Scene {
  cells: ReturnType<typeof generateCells>;
  wallSize: { width: number; height: number };
  tileCount: number;
  tiles: TileEntry[];
  inserts: InsertEntry[];
  clipCount: number;
  mountCount: number;
  mergedCount: number;
  insertCellsTotal: number;
  insertDistribution: string;
  beds: ReturnType<typeof packBeds>;
  viewerMeshes: ColoredMesh[];
  triangles: number;
  seamCount: number;
  plan: ReturnType<typeof subdivideWall>;
}

interface SceneInputs {
  userOutline: Polygon;
  plate: PlateSpec;
  margin: number;
  borderEnabled: boolean;
  borderThickness: number;
  borderClipThreshold: number;
  wallMountsTotal: number | undefined;
  bridgesPerSeam: number | undefined;
  seamInsertsPerRun: number | undefined;
  mergeMountsWithClips: boolean;
  defaultClipVariant: CellVariant;
  defaultMountVariant: CellVariant;
  cellOverrides: Record<string, CellVariant>;
  /** Panel cell hole expansion (mm/side) — applied ONLY to tile mesh generation
   * so an original insert (or one printed in another material) fits at design
   * clearance. Insert bodies stay at nominal dimensions. */
  cellHoleExpansion: number;
}

export interface ComputeProgress {
  /** Items completed so far (tiles + inserts). */
  done: number;
  /** Total items to render. */
  total: number;
  /** Short label of the current item, for UI display. */
  current: string;
}

async function computeScene(
  inputs: SceneInputs,
  onProgress?: (p: ComputeProgress) => void,
): Promise<Scene> {
  const {
    userOutline,
    plate,
    margin,
    borderEnabled,
    borderThickness,
    borderClipThreshold,
    wallMountsTotal,
    bridgesPerSeam,
    seamInsertsPerRun,
    mergeMountsWithClips,
    defaultClipVariant,
    defaultMountVariant,
    cellOverrides,
    cellHoleExpansion,
  } = inputs;

  // Layout / subdivision / cell-generation use nominal HSW_STANDARD (pitches
  // and centres are unaffected by hole shrinkage comp). Only tile meshes
  // enlarge the cell hole via panelParams, so an original insert can snap
  // into a PLA-shrunk panel at design clearance.
  const panelParams = { ...HSW_STANDARD, cellHoleExpansion };
  const border = { enabled: borderEnabled, thickness: borderThickness };
  const clearance = borderEnabled ? borderThickness : HSW_STANDARD.wallThickness / 2;
  const placement: Polygon = userOutline.length >= 3 ? userOutline : rectangleOutline(40, 40);
  const generateOpts = borderEnabled
    ? { partialMinAreaRatio: borderClipThreshold / 100 }
    : undefined;
  const cells = generateCells(placement, HSW_STANDARD, clearance, generateOpts);

  let customOutline: Polygon | undefined;
  if (!borderEnabled) {
    const traced = traceBorderlessOutline(cells, HSW_STANDARD);
    customOutline = traced.length >= 3 ? traced : placement;
  } else {
    customOutline = placement;
  }

  const plan = subdivideWall(cells, HSW_STANDARD, plate, border, margin, customOutline);

  let doneCount = 0;
  // Total = tiles + (clip inserts + mounts, computed below). We don't know
  // mount/insert counts until subdivision runs, so emit the tile-only total
  // first and bump it again before insert rendering starts.
  const tilesTotal = plan.tiles.length;
  onProgress?.({ done: 0, total: tilesTotal, current: "subdivision" });
  // Render tiles sequentially so progress updates make sense (OpenSCAD is
  // already serialised globally — we just want orderly UI updates).
  const tileEntries: TileEntry[] = [];
  // Border-clipped half-cells keep their snap-step (front pocket + rear groove)
  // when the panel has no closed frame, so the open edge can host clip inserts
  // for a future extension. With border ON the frame seals the panel and the
  // half-cell snap features are unreachable, so straight extrusion is fine.
  const clipNoSnap = borderEnabled;
  for (let i = 0; i < plan.tiles.length; i++) {
    const t = plan.tiles[i];
    onProgress?.({ done: doneCount, total: tilesTotal, current: `tile ${i + 1}/${tilesTotal}` });
    const panelCells = t.cells.map((c) =>
      c.clipped ? { center: c.center, clipped: c.clipped, clipNoSnap } : { center: c.center },
    );
    const mesh = await buildTileMesh(t.outline, panelCells, panelParams);
    tileEntries.push({
      id: t.id,
      mesh,
      color: TILE_COLORS[i % TILE_COLORS.length],
      bbox: { width: t.bbox.width, height: t.bbox.height, min: t.bbox.min as [number, number] },
      cells: t.cells.length,
    });
    doneCount++;
  }

  const verticalClipSpecs = placeSeamInserts(
    cells,
    plan.seamCells,
    plan.xSeams,
    plan.ySeams,
    HSW_STANDARD,
    seamInsertsPerRun,
  );
  // A cell that already hosts a vertical-seam cluster cannot also host a
  // bridge — both inserts plug their body into the same panel cell and
  // would collide. Build the "already used" set from the cluster centres
  // and pass it down so bridges skip those cells.
  const seamUsedCellKeys = new Set<string>();
  for (const ins of verticalClipSpecs) {
    for (const centre of ins.centers) {
      const cell = cells.find(
        (c) =>
          Math.abs(c.center[0] - centre[0]) < 0.5 &&
          Math.abs(c.center[1] - centre[1]) < 0.5,
      );
      if (cell) seamUsedCellKeys.add(`${cell.col}_${cell.row}`);
    }
  }
  const bridgeSpecs = placeBridgeInserts(
    cells,
    plan.ySeams,
    HSW_STANDARD,
    bridgesPerSeam,
    seamUsedCellKeys,
  );
  const rawClipSpecs = [...verticalClipSpecs, ...bridgeSpecs];
  const snapTargets = mergeMountsWithClips
    ? clipFullCellKeys(rawClipSpecs, cells, plan.seamCells)
    : new Set<string>();
  const rawMountSpecs = placeWallMountInserts(
    plan.tiles,
    plan.seamCells,
    wallMountsTotal,
    snapTargets,
  );
  const merged = mergeMountsWithClips
    ? mergeWallMountsIntoClips(rawClipSpecs, rawMountSpecs)
    : { clips: rawClipSpecs, mounts: rawMountSpecs };
  const clipSpecs = merged.clips;
  const mountSpecs = merged.mounts;
  const mergedCount = rawMountSpecs.length - mountSpecs.length;

  const resolveVariants = (ins: {
    id: string;
    kind: string;
    centers: unknown[];
    mountIndices?: number[];
  }): CellVariant[] => {
    const mountSet = new Set(ins.mountIndices ?? []);
    return ins.centers.map((_, ci) => {
      const key = `${ins.id}:${ci}`;
      if (key in cellOverrides) return cellOverrides[key];
      if (ins.kind === "wallMount" || mountSet.has(ci)) return defaultMountVariant;
      return defaultClipVariant;
    });
  };

  const allInsertSpecs = [
    ...clipSpecs.map((ins) => ({ ins, cellCount: ins.centers.length })),
    ...mountSpecs.map((ins) => ({ ins, cellCount: 1 })),
  ];
  const grandTotal = tilesTotal + allInsertSpecs.length;
  const insertEntries: InsertEntry[] = [];
  for (let i = 0; i < allInsertSpecs.length; i++) {
    const { ins, cellCount } = allInsertSpecs[i];
    const variants = resolveVariants(ins);
    onProgress?.({
      done: doneCount,
      total: grandTotal,
      current: `${ins.kind === "wallMount" ? "mount" : "clip"} ${i + 1}/${allInsertSpecs.length}`,
    });
    const mesh = await buildInsertMesh(ins.centers, HSW_STANDARD, undefined, { variants });
    insertEntries.push({
      id: ins.id,
      spec: ins,
      variants,
      mesh,
      cellCount,
    });
    doneCount++;
  }
  onProgress?.({ done: doneCount, total: grandTotal, current: "done" });

  const clipEntries = insertEntries.filter((i) => i.spec.kind === "clip");
  const mountEntries = insertEntries.filter((i) => i.spec.kind === "wallMount");
  const insertCellsTotal = clipEntries.reduce((s, i) => s + i.cellCount, 0);
  const insertSizeCounts = new Map<number, number>();
  for (const ins of clipEntries) {
    insertSizeCounts.set(ins.cellCount, (insertSizeCounts.get(ins.cellCount) ?? 0) + 1);
  }
  const insertDistribution =
    clipEntries.length === 0
      ? ""
      : [...insertSizeCounts.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([size, count]) => `${count}×${size}-cell`)
          .join(", ");

  // Categorise each viewer mesh so the Viewer's view-mode logic knows
  // how to colour and (in exploded view) how to offset it.
  //   tile_*    → tile      (per-tile palette)
  //   bridge_*  → bridge    (horizontal seam connectors, yellow)
  //   mount_*   → mount     (wall fixings, red)
  //   anything else (insert_*, etc.) → clip (orange)
  const insertCategory = (id: string, kind: string): "clip" | "bridge" | "mount" => {
    if (kind === "wallMount") return "mount";
    if (id.startsWith("bridge_")) return "bridge";
    return "clip";
  };
  const insertColor = (cat: "clip" | "bridge" | "mount"): string =>
    cat === "mount" ? WALL_MOUNT_COLOR : cat === "bridge" ? BRIDGE_INSERT_COLOR : CLIP_INSERT_COLOR;
  const viewerMeshes: ColoredMesh[] = [
    ...tileEntries.map((t) => ({
      key: t.id,
      mesh: t.mesh,
      color: t.color,
      category: "tile" as const,
    })),
    ...insertEntries.map((i) => {
      const cat = insertCategory(i.id, i.spec.kind);
      return { key: i.id, mesh: i.mesh, color: insertColor(cat), category: cat };
    }),
  ];
  const triangles =
    tileEntries.reduce((s, t) => s + t.mesh.indices.length / 3, 0) +
    insertEntries.reduce((s, i) => s + i.mesh.indices.length / 3, 0);

  let wMinX = Infinity,
    wMinY = Infinity,
    wMaxX = -Infinity,
    wMaxY = -Infinity;
  for (const [x, y] of plan.wallOutline) {
    if (x < wMinX) wMinX = x;
    if (y < wMinY) wMinY = y;
    if (x > wMaxX) wMaxX = x;
    if (y > wMaxY) wMaxY = y;
  }

  const packInputs = [
    ...tileEntries.map((t) => ({ id: t.id, width: t.bbox.width, height: t.bbox.height })),
    ...insertEntries.map((i) => {
      const b = meshBounds3(i.mesh);
      return { id: i.id, width: b.max[0] - b.min[0], height: b.max[1] - b.min[1] };
    }),
  ];
  const beds = packBeds(packInputs, plate, margin, 2);

  return {
    cells,
    wallSize: { width: wMaxX - wMinX, height: wMaxY - wMinY },
    tileCount: tileEntries.length,
    tiles: tileEntries,
    inserts: insertEntries,
    clipCount: clipEntries.length,
    mountCount: mountEntries.length,
    mergedCount,
    insertCellsTotal,
    insertDistribution,
    beds,
    viewerMeshes,
    triangles,
    seamCount: plan.seamCells.length,
    plan,
  };
}

type ModalId = "setup" | "inserts" | "stats" | "display" | "agent" | null;

// Persisted user settings — every input the user adjusts in the modals.
// Ephemeral state (computed scene, in-flight progress, open modal) is NOT
// persisted; only the parameters that produce a given wall.
//
// Migration model: the stored JSON is an envelope `{ schemaVersion, settings }`
// so the load path can run forward-migrations when SCHEMA_VERSION bumps. The
// storage KEY stays constant — versioning lives inside the data. When you
// change the PersistedSettings shape, bump SCHEMA_VERSION and add an entry to
// MIGRATIONS that takes the previous shape and returns the next. Saves from
// before the envelope existed (bare PersistedSettings JSON) are auto-detected
// and treated as schemaVersion=1.
const SETTINGS_STORAGE_KEY = "hsw-builder:settings:v1";
const SCHEMA_VERSION = 2;

interface PersistedSettings {
  shape: ShapeState;
  plateId: string;
  customPlate: { width: number; height: number };
  margin: number;
  borderEnabled: boolean;
  borderThickness: number;
  borderClipThreshold: number;
  wallMountsTotal: number | undefined;
  bridgesPerSeam: number | undefined;
  seamInsertsPerRun: number | undefined;
  mergeMountsWithClips: boolean;
  defaultClipVariant: CellVariant;
  defaultMountVariant: CellVariant;
  cellOverrides: Record<string, CellVariant>;
  printWallColor: string;
  printInsertColor: string;
  /** Radial expansion of the panel cell hole (mm/side) to compensate print
   * shrinkage. See MATERIAL_PROFILES for presets. Added in v2. */
  cellHoleExpansion: number;
}

interface SettingsEnvelope {
  schemaVersion: number;
  settings: PersistedSettings;
}

// Forward migrations. MIGRATIONS[v] runs the v → v+1 transformation.
const MIGRATIONS = new Map<number, (prev: unknown) => unknown>();
// v1 → v2: adds cellHoleExpansion (default 0 = PETG baseline, matches
// pre-migration behaviour when the panel cell hole was not compensated).
MIGRATIONS.set(1, (v1) => {
  const prev = (v1 ?? {}) as Record<string, unknown>;
  return { ...prev, cellHoleExpansion: 0 };
});

function loadPersistedSettings(): Partial<PersistedSettings> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);

    // Detect envelope vs. legacy bare-payload format. Bare payloads predate
    // this migration system; they correspond to schemaVersion=1 (the first
    // shape ever shipped).
    let version: number;
    let data: unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "schemaVersion" in parsed &&
      "settings" in parsed
    ) {
      const envelope = parsed as SettingsEnvelope;
      version = envelope.schemaVersion;
      data = envelope.settings;
    } else {
      version = 1;
      data = parsed;
    }

    while (version < SCHEMA_VERSION) {
      const migrate = MIGRATIONS.get(version);
      if (!migrate) {
        // No migration path defined — refuse the data rather than corrupt
        // state with a partial schema. User falls back to defaults.
        return null;
      }
      data = migrate(data);
      version += 1;
    }
    if (version !== SCHEMA_VERSION) return null;
    return data as Partial<PersistedSettings>;
  } catch {
    return null;
  }
}

function savePersistedSettings(payload: PersistedSettings): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: SettingsEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      settings: payload,
    };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    /* localStorage unavailable / quota exceeded — ignored */
  }
}

export default function Home() {
  const [openModal, setOpenModal] = useState<ModalId>(null);
  const toggleModal = (id: Exclude<ModalId, null>) =>
    setOpenModal((cur) => (cur === id ? null : id));
  const [printWallColor, setPrintWallColor] = useState(DEFAULT_PRINT_WALL_COLOR);
  const [printInsertColor, setPrintInsertColor] = useState(DEFAULT_PRINT_INSERT_COLOR);
  const [shape, setShape] = useState<ShapeState>(DEFAULT_SHAPE_STATE);
  const [plateId, setPlateId] = useState(PLATE_PRESETS[1].id);
  const [customPlate, setCustomPlate] = useState({ width: 220, height: 220 });
  const [margin, setMargin] = useState(DEFAULT_PLATE_MARGIN);
  const [borderEnabled, setBorderEnabled] = useState(DEFAULT_BORDER.enabled);
  const [borderThickness, setBorderThickness] = useState(DEFAULT_BORDER.thickness);
  const [borderClipThreshold, setBorderClipThreshold] = useState(25);
  // Print-material shrinkage compensation for the panel cell hole. 0 = PETG
  // baseline (RostaP native). See MATERIAL_PROFILES for presets. Applied only
  // to panel geometry (cell hole flats); insert geometry stays nominal.
  const [cellHoleExpansion, setCellHoleExpansion] = useState<number>(0);
  const [wallMountsTotal, setWallMountsTotal] = useState<number | undefined>(undefined);
  const [bridgesPerSeam, setBridgesPerSeam] = useState<number | undefined>(undefined);
  const [seamInsertsPerRun, setSeamInsertsPerRun] = useState<number | undefined>(undefined);
  const [mergeMountsWithClips, setMergeMountsWithClips] = useState(true);
  const [defaultClipVariant, setDefaultClipVariant] = useState<CellVariant>("empty");
  const [defaultMountVariant, setDefaultMountVariant] = useState<CellVariant>("countersunk-m3");
  const [cellOverrides, setCellOverrides] = useState<Record<string, CellVariant>>({});

  const userOutline = useMemo(() => computePolygon(shape), [shape]);
  const isArbitraryShape = shape.mode !== "rectangle";

  const plate: PlateSpec =
    plateId === CUSTOM_PLATE_ID
      ? {
          id: CUSTOM_PLATE_ID,
          label: `Custom (${customPlate.width}x${customPlate.height})`,
          width: customPlate.width,
          height: customPlate.height,
        }
      : (PLATE_PRESETS.find((p) => p.id === plateId) ?? PLATE_PRESETS[0]);

  const EMPTY_SCENE: Scene = useMemo(
    () => ({
      cells: [],
      wallSize: { width: 0, height: 0 },
      tileCount: 0,
      tiles: [],
      inserts: [],
      clipCount: 0,
      mountCount: 0,
      mergedCount: 0,
      insertCellsTotal: 0,
      insertDistribution: "",
      beds: [],
      viewerMeshes: [],
      triangles: 0,
      seamCount: 0,
      plan: { wallOutline: [], tiles: [], seamCells: [], xSeams: [], ySeams: [] },
    }),
    [],
  );
  const [scene, setScene] = useState<Scene>(EMPTY_SCENE);
  const [computing, setComputing] = useState(false);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);

  // Start downloading + warming up the OpenSCAD WASM module on mount, in the
  // background. The first Generate click is then much closer to real CSG
  // time, not module-load time.
  useEffect(() => {
    prewarmOpenScad();
  }, []);

  // Restore persisted settings on mount. SSR-safe: initial useState above uses
  // hardcoded defaults so the server-side render matches the first client
  // render; localStorage is read AFTER hydration and applied via setState.
  // This causes a brief one-frame flash of defaults if the user had previous
  // settings, which is acceptable. The subsequent state updates also trigger
  // the live-reload debounce, so the wall auto-regenerates with the restored
  // params — no manual click needed.
  useEffect(() => {
    const loaded = loadPersistedSettings();
    if (!loaded) return;
    if (loaded.shape) setShape(loaded.shape);
    if (loaded.plateId !== undefined) setPlateId(loaded.plateId);
    if (loaded.customPlate) setCustomPlate(loaded.customPlate);
    if (loaded.margin !== undefined) setMargin(loaded.margin);
    if (loaded.borderEnabled !== undefined) setBorderEnabled(loaded.borderEnabled);
    if (loaded.borderThickness !== undefined) setBorderThickness(loaded.borderThickness);
    if (loaded.borderClipThreshold !== undefined) setBorderClipThreshold(loaded.borderClipThreshold);
    if (loaded.cellHoleExpansion !== undefined) setCellHoleExpansion(loaded.cellHoleExpansion);
    if ("wallMountsTotal" in loaded) setWallMountsTotal(loaded.wallMountsTotal);
    if ("bridgesPerSeam" in loaded) setBridgesPerSeam(loaded.bridgesPerSeam);
    if ("seamInsertsPerRun" in loaded) setSeamInsertsPerRun(loaded.seamInsertsPerRun);
    if (loaded.mergeMountsWithClips !== undefined) setMergeMountsWithClips(loaded.mergeMountsWithClips);
    if (loaded.defaultClipVariant) setDefaultClipVariant(loaded.defaultClipVariant);
    if (loaded.defaultMountVariant) setDefaultMountVariant(loaded.defaultMountVariant);
    if (loaded.cellOverrides) setCellOverrides(loaded.cellOverrides);
    if (loaded.printWallColor) setPrintWallColor(loaded.printWallColor);
    if (loaded.printInsertColor) setPrintInsertColor(loaded.printInsertColor);
  }, []);

  // Persist settings on change. Storage is best-effort: quota / private-mode
  // failures are swallowed by savePersistedSettings so the user keeps a
  // working in-memory session.
  useEffect(() => {
    savePersistedSettings({
      shape,
      plateId,
      customPlate,
      margin,
      borderEnabled,
      borderThickness,
      borderClipThreshold,
      wallMountsTotal,
      bridgesPerSeam,
      seamInsertsPerRun,
      mergeMountsWithClips,
      defaultClipVariant,
      defaultMountVariant,
      cellOverrides,
      printWallColor,
      printInsertColor,
      cellHoleExpansion,
    });
  }, [
    shape,
    plateId,
    customPlate,
    margin,
    borderEnabled,
    borderThickness,
    borderClipThreshold,
    wallMountsTotal,
    bridgesPerSeam,
    seamInsertsPerRun,
    mergeMountsWithClips,
    defaultClipVariant,
    defaultMountVariant,
    cellOverrides,
    printWallColor,
    printInsertColor,
    cellHoleExpansion,
  ]);

  // Stable signature of every input that affects the scene. Changes here mean
  // the user has parameters newer than what's currently rendered (dirty).
  const inputsSignature = useMemo(
    () =>
      JSON.stringify({
        userOutline,
        plateId,
        customW: customPlate.width,
        customH: customPlate.height,
        margin,
        borderEnabled,
        borderThickness,
        borderClipThreshold,
        wallMountsTotal: wallMountsTotal ?? null,
        bridgesPerSeam: bridgesPerSeam ?? null,
        seamInsertsPerRun: seamInsertsPerRun ?? null,
        mergeMountsWithClips,
        defaultClipVariant,
        defaultMountVariant,
        cellOverrides,
        cellHoleExpansion,
      }),
    [
      userOutline,
      plateId,
      customPlate.width,
      customPlate.height,
      margin,
      borderEnabled,
      borderThickness,
      borderClipThreshold,
      wallMountsTotal,
      bridgesPerSeam,
      seamInsertsPerRun,
      mergeMountsWithClips,
      defaultClipVariant,
      defaultMountVariant,
      cellOverrides,
      cellHoleExpansion,
    ],
  );

  // Signature of the inputs used for the last completed render. When the
  // current `inputsSignature` differs, the scene is stale (dirty) and the
  // Generate button highlights so the user knows to re-run.
  const [appliedSignature, setAppliedSignature] = useState<string | null>(null);
  const isDirty = appliedSignature !== inputsSignature;

  // Live-reload effect: re-renders ~600 ms after the user stops editing
  // parameters. The OpenSCAD Manifold backend brings a moderate panel to
  // ~1-2 s total, so live reload is responsive again. The Generate button is
  // still there for explicit re-runs (no-op when nothing's dirty).
  const [generateTrigger, setGenerateTrigger] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const debounceMs = 600;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setGenerateTrigger((n) => n + 1);
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inputsSignature]);

  useEffect(() => {
    if (generateTrigger === 0) return;
    let cancelled = false;
    setComputing(true);
    setProgress(null);
    const targetSignature = inputsSignature;
    (async () => {
      const next = await computeScene(
        {
          userOutline,
          plate,
          margin,
          borderEnabled,
          borderThickness,
          borderClipThreshold,
          wallMountsTotal,
          bridgesPerSeam,
          seamInsertsPerRun,
          mergeMountsWithClips,
          defaultClipVariant,
          defaultMountVariant,
          cellOverrides,
          cellHoleExpansion,
        },
        (p) => {
          if (!cancelled) setProgress(p);
        },
      );
      if (!cancelled) {
        setScene(next);
        setAppliedSignature(targetSignature);
        setComputing(false);
        setProgress(null);
      }
    })().catch((e) => {
      if (!cancelled) {
        console.error(e);
        setComputing(false);
        setProgress(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // We intentionally depend only on `generateTrigger`. Param changes are
    // snapshotted at click time via closures — re-running on every param
    // change is exactly what we're avoiding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateTrigger]);

  const fits = scene.tileCount > 0 && tilesFitPlate(scene.plan, plate, margin);
  const subdivided = scene.tileCount > 1;

  const requestedW = userOutline.length >= 3
    ? Math.max(...userOutline.map((v) => v[0])) - Math.min(...userOutline.map((v) => v[0]))
    : 0;
  const requestedH = userOutline.length >= 3
    ? Math.max(...userOutline.map((v) => v[1])) - Math.min(...userOutline.map((v) => v[1]))
    : 0;
  const baseName = `hsw-${shape.mode}-${Math.round(requestedW)}x${Math.round(requestedH)}`;

  const agentContext = {
    shape:
      shape.mode === "rectangle"
        ? { mode: "rectangle", ...shape.rectangle }
        : shape.mode === "sides"
        ? { mode: "regular_polygon", sides: shape.sides.count, side_length: shape.sides.length }
        : { mode: shape.mode },
    plate: {
      id: plate.id,
      label: plate.label,
      width: plate.width,
      height: plate.height,
      margin,
    },
    border: { enabled: borderEnabled, thickness: borderThickness },
    wall_mounts_total: wallMountsTotal ?? "auto",
    bridges_per_seam: bridgesPerSeam ?? "auto",
    vertical_seam_inserts_per_run: seamInsertsPerRun ?? "auto",
    merge_mounts_with_clips: mergeMountsWithClips,
    default_clip_variant: defaultClipVariant,
    default_mount_variant: defaultMountVariant,
    material_profile: materialProfileFromExpansion(cellHoleExpansion),
    cell_hole_expansion_mm: cellHoleExpansion,
    cell_overrides_count: Object.keys(cellOverrides).length,
    derived: {
      cells: scene.cells.length,
      tile_count: scene.tileCount,
      print_plates: scene.beds.length,
      fits_plate: fits,
      wall_actual_mm: scene.wallSize,
    },
  };

  const handleAgentTool = (call: { name: string; input: Record<string, unknown> }) => {
    const i = call.input;
    switch (call.name) {
      case "set_rectangle_shape":
        setShape({
          ...DEFAULT_SHAPE_STATE,
          mode: "rectangle",
          rectangle: { width: Number(i.width), height: Number(i.height) },
        });
        return;
      case "set_regular_polygon_shape":
        setShape({
          ...DEFAULT_SHAPE_STATE,
          mode: "sides",
          sides: { count: Math.max(3, Math.round(Number(i.sides))), length: Number(i.side_length) },
        });
        return;
      case "set_vertex_polygon_shape": {
        const verts = Array.isArray(i.vertices) ? (i.vertices as number[][]) : [];
        const text = verts.map((p) => `${p[0]} ${p[1]}`).join("\n");
        setShape({ ...DEFAULT_SHAPE_STATE, mode: "vertices", vertices: { text } });
        return;
      }
      case "set_plate_preset":
        setPlateId(String(i.preset_id));
        return;
      case "set_custom_plate":
        setPlateId(CUSTOM_PLATE_ID);
        setCustomPlate({ width: Number(i.width), height: Number(i.height) });
        return;
      case "set_margin":
        setMargin(Number(i.margin));
        return;
      case "set_border":
        setBorderEnabled(Boolean(i.enabled));
        setBorderThickness(Math.max(HSW_STANDARD.wallThickness / 2, Number(i.thickness)));
        return;
      case "set_wall_mounts": {
        const v = i.total;
        if (v === "auto" || v === null || v === undefined) {
          setWallMountsTotal(undefined);
        } else {
          const count = Math.max(0, Math.round(Number(v)));
          setWallMountsTotal(count);
        }
        return;
      }
      case "set_bridges": {
        const v = i.per_seam;
        if (v === "auto" || v === null || v === undefined) {
          setBridgesPerSeam(undefined);
        } else {
          const count = Math.round(Number(v));
          setBridgesPerSeam([0, 1, 2, 3, 5].includes(count) ? count : undefined);
        }
        return;
      }
      case "set_seam_inserts": {
        const v = i.per_seam;
        if (v === "auto" || v === null || v === undefined) {
          setSeamInsertsPerRun(undefined);
        } else {
          const count = Math.round(Number(v));
          setSeamInsertsPerRun([0, 1, 2, 3, 5].includes(count) ? count : undefined);
        }
        return;
      }
      case "set_merge_mounts": {
        setMergeMountsWithClips(Boolean(i.enabled));
        return;
      }
      case "set_clip_variant": {
        const v = String(i.variant) as CellVariant;
        if (ALL_CELL_VARIANTS.includes(v)) setDefaultClipVariant(v);
        return;
      }
      case "set_mount_variant": {
        const v = String(i.variant) as CellVariant;
        if (ALL_CELL_VARIANTS.includes(v)) setDefaultMountVariant(v);
        return;
      }
      case "set_material_profile": {
        const profile = String(i.profile) as MaterialProfile;
        if (profile === "custom") {
          const raw = Number(i.expansion);
          if (Number.isFinite(raw)) {
            // Clamp to the same range the UI accepts (see NumberField below).
            setCellHoleExpansion(Math.max(-0.5, Math.min(0.5, raw)));
          }
        } else if (profile in MATERIAL_PROFILES) {
          setCellHoleExpansion(MATERIAL_PROFILES[profile]);
        }
        return;
      }
      default:
        console.warn("Unknown agent tool:", call.name);
    }
  };

  const buildAssembly = () => {
    if (!scene.plan) return null;
    return buildAssemblyMap({
      requestedSize: { width: requestedW, height: requestedH },
      wallSize: scene.wallSize,
      plate,
      margin,
      tiles: scene.plan.tiles,
      inserts: scene.inserts.map((i) => i.spec),
      beds: scene.beds,
    });
  };

  const handleDownloadStls = () => {
    if (scene.tileCount === 1 && scene.inserts.length === 0) {
      downloadStl(scene.tiles[0].mesh, baseName);
      return;
    }
    const meshes = [
      ...scene.tiles.map((t) => ({ name: `${baseName}/${t.id}`, mesh: t.mesh })),
      ...scene.inserts.map((i) => ({ name: `${baseName}/${i.id}`, mesh: i.mesh })),
    ];
    const map = buildAssembly();
    downloadStlZip(meshes, baseName, map ? assemblyMapToReadme(map) : undefined);
  };

  const handleDownloadThreeMf = () => {
    if (scene.beds.length === 0) return;
    let objectId = 1;
    const meshById = new Map<string, Mesh>();
    for (const t of scene.tiles) meshById.set(t.id, t.mesh);
    for (const i of scene.inserts) meshById.set(i.id, i.mesh);
    const bedFiles = scene.beds.map((bed) => {
      const objects = bed.items
        .map((item) => {
          const baseMesh = meshById.get(item.id);
          if (!baseMesh) return null;
          let m = recenterToOrigin(baseMesh).mesh;
          if (item.rotated) {
            m = recenterToOrigin(rotate90Z(m)).mesh;
          }
          return {
            id: objectId++,
            mesh: m,
            translate: [item.x, item.y, 0] as [number, number, number],
            rotateDegZ: 0 as const,
          };
        })
        .filter(Boolean) as Array<{
          id: number;
          mesh: Mesh;
          translate: [number, number, number];
          rotateDegZ: 0;
        }>;
      return { name: `plate_${bed.index + 1}`, objects };
    });
    const map = buildAssembly();
    downloadThreeMfZip(bedFiles, `${baseName}-3mf`, map ? assemblyMapToReadme(map) : undefined);
  };

  return (
    <div className={styles.layout}>
      <div className={styles.viewer}>
        <Viewer
          meshes={scene.viewerMeshes}
          printWallColor={printWallColor}
          printInsertColor={printInsertColor}
        />
        {computing && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(13, 13, 16, 0.6)",
              backdropFilter: "blur(2px)",
              pointerEvents: "none",
              gap: 12,
              color: "#e4e4ea",
              zIndex: 20,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                border: "4px solid rgba(255,255,255,0.15)",
                borderTopColor: "#3a6dff",
                borderRadius: "50%",
                animation: "hexweave-spin 0.9s linear infinite",
              }}
            />
            <div style={{ fontSize: 14, fontWeight: 500 }}>
              {progress ? `Rendering ${progress.current}` : "Rendering…"}
            </div>
            {progress && progress.total > 0 && (
              <div style={{ fontSize: 12, color: "#b8b8c2" }}>
                {progress.done} / {progress.total}
                <div
                  style={{
                    width: 180,
                    height: 4,
                    background: "rgba(255,255,255,0.1)",
                    borderRadius: 2,
                    marginTop: 6,
                  }}
                >
                  <div
                    style={{
                      width: `${(progress.done / progress.total) * 100}%`,
                      height: "100%",
                      background: "#3a6dff",
                      borderRadius: 2,
                      transition: "width 0.2s ease-out",
                    }}
                  />
                </div>
              </div>
            )}
            <style>{`@keyframes hexweave-spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {!computing && scene.tileCount === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              color: "#8a8a96",
              fontSize: 14,
              textAlign: "center",
              padding: 40,
            }}
          >
            {appliedSignature === null
              ? "Set the wall parameters then click Generate."
              : "No geometry — adjust the shape and regenerate."}
          </div>
        )}

        <div className={styles.appTitle}>HEXWEAVE</div>

        <div className={styles.toolbar}>
          <ToolbarButton active={openModal === "setup"} onClick={() => toggleModal("setup")} title="Setup (shape, bed, border)">
            <SetupIcon />
          </ToolbarButton>
          <ToolbarButton active={openModal === "inserts"} onClick={() => toggleModal("inserts")} title="Inserts (seams, bridges, mounts, variants)">
            <InsertsIcon />
          </ToolbarButton>
          <ToolbarButton active={openModal === "stats"} onClick={() => toggleModal("stats")} title="Stats">
            <StatsIcon />
          </ToolbarButton>
          <ToolbarButton active={openModal === "display"} onClick={() => toggleModal("display")} title="Display (print colours)">
            <DisplayIcon />
          </ToolbarButton>
          <ToolbarButton active={openModal === "agent"} onClick={() => toggleModal("agent")} title="Agent">
            <AgentIcon />
          </ToolbarButton>
        </div>

        {openModal === "setup" && (
          <Modal title="Setup" onClose={() => setOpenModal(null)}>
            <div className={styles.group}>
              <div className={styles.groupTitle}>Wall shape</div>
              <ShapeInput state={shape} onChange={setShape} parsedPolygon={userOutline} />
              {scene.wallSize.width > 0 && (
                <p className={styles.hint}>
                  Wall bbox: <b>{scene.wallSize.width.toFixed(1)} x {scene.wallSize.height.toFixed(1)} mm</b>
                  {!isArbitraryShape && borderEnabled && " (snug to lattice)"}
                  {!borderEnabled && " (cell-edged)"}
                </p>
              )}
            </div>

        <div className={styles.group}>
          <div className={styles.groupTitle}>Print bed</div>
          <div className={styles.field}>
            <label>Preset</label>
            <select value={plateId} onChange={(e) => setPlateId(e.target.value)}>
              {PLATE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM_PLATE_ID}>Custom...</option>
            </select>
          </div>
          {plateId === CUSTOM_PLATE_ID && (
            <>
              <NumberField
                label="Bed W (mm)"
                value={customPlate.width}
                min={40}
                onChange={(v) => setCustomPlate((p) => ({ ...p, width: v }))}
              />
              <NumberField
                label="Bed H (mm)"
                value={customPlate.height}
                min={40}
                onChange={(v) => setCustomPlate((p) => ({ ...p, height: v }))}
              />
            </>
          )}
          <NumberField
            label="Margin (mm)"
            value={margin}
            min={0}
            step={0.5}
            onChange={setMargin}
          />
        </div>

        <div className={styles.group}>
          <div className={styles.groupTitle}>Border</div>
          <div className={styles.field}>
            <label style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={borderEnabled}
                onChange={(e) => setBorderEnabled(e.target.checked)}
                style={{ width: "auto", marginRight: 6 }}
              />
              Frame around the honeycomb
            </label>
          </div>
          {borderEnabled && (
            <>
              <NumberField
                label="Thickness (mm)"
                value={borderThickness}
                min={HSW_STANDARD.wallThickness / 2}
                step={0.1}
                onChange={setBorderThickness}
              />
              <NumberField
                label="Min cell area (%)"
                value={borderClipThreshold}
                min={0}
                max={100}
                step={5}
                onChange={setBorderClipThreshold}
              />
            </>
          )}
          <p className={styles.hint}>
            Cell size is locked to the HSW standard so clip inserts stay compatible.
            {!borderEnabled && " Borderless: panel edge follows the cells (cells-only)."}
            {borderEnabled && (
              " Bordered: wall keeps your exact dimensions; cells at the inner edge are clipped to fit. " +
              "Min cell area = drop slivers whose clipped area is below this fraction of a full hex. " +
              "0 % = keep every sliver (fragile prints); 50 % = drop anything smaller than half a cell (chunky border)."
            )}
          </p>
        </div>

        <div className={styles.group}>
          <div className={styles.groupTitle}>Print material</div>
          <div className={styles.field}>
            <label>Preset</label>
            <select
              value={materialProfileFromExpansion(cellHoleExpansion)}
              onChange={(e) => {
                const profile = e.target.value as MaterialProfile;
                if (profile !== "custom") {
                  setCellHoleExpansion(MATERIAL_PROFILES[profile]);
                }
                // "custom" leaves cellHoleExpansion at its current value and
                // exposes the numeric input below for direct editing.
              }}
            >
              <option value="PETG">PETG (RostaP native, no comp)</option>
              <option value="PLA">PLA (+0.15 mm/side)</option>
              <option value="ABS">ABS (-0.05 mm/side)</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          {materialProfileFromExpansion(cellHoleExpansion) === "custom" && (
            <NumberField
              label="Cell hole expansion (mm/side)"
              value={cellHoleExpansion}
              min={-0.5}
              max={0.5}
              step={0.05}
              onChange={setCellHoleExpansion}
            />
          )}
          <p className={styles.hint}>
            Enlarges the panel cell hole radially to compensate print-material
            shrinkage / over-extrusion so an original RostaP insert (or one
            printed in a different material) still fits at the design clearance.
            Leave at PETG (0 mm) when both panel and insert are printed in the
            same material. Insert geometry is never scaled by this setting.
          </p>
        </div>
          </Modal>
        )}

        {openModal === "inserts" && (
          <Modal title="Inserts" onClose={() => setOpenModal(null)}>
        {subdivided && (
          <div className={styles.group}>
            <div className={styles.groupTitle}>Vertical seam inserts</div>
            <div className={styles.field}>
              <label>Per seam</label>
              <select
                value={seamInsertsPerRun === undefined ? "auto" : String(seamInsertsPerRun)}
                onChange={(e) => {
                  const v = e.target.value;
                  setSeamInsertsPerRun(v === "auto" ? undefined : Number(v));
                }}
              >
                <option value="auto">Auto (structural minimum)</option>
                <option value="0">0 (none)</option>
                <option value="1">1 (centre)</option>
                <option value="2">2 (evenly spaced)</option>
                <option value="3">3 (evenly spaced)</option>
                <option value="5">5 (evenly spaced)</option>
              </select>
            </div>
            <p className={styles.hint}>
              3-cell clip inserts on the bisected cells of each vertical seam. Auto = ~1
              insert every 200 mm of seam length (min 1, capped so inserts don't overlap).
            </p>
          </div>
        )}

        {subdivided && (
          <div className={styles.group}>
            <div className={styles.groupTitle}>Horizontal seam bridges</div>
            <div className={styles.field}>
              <label>Per seam</label>
              <select
                value={bridgesPerSeam === undefined ? "auto" : String(bridgesPerSeam)}
                onChange={(e) => {
                  const v = e.target.value;
                  setBridgesPerSeam(v === "auto" ? undefined : Number(v));
                }}
              >
                <option value="auto">Auto (structural minimum)</option>
                <option value="0">0 (none)</option>
                <option value="1">1 (centre)</option>
                <option value="2">2 (evenly spaced)</option>
                <option value="3">3 (evenly spaced)</option>
                <option value="5">5 (evenly spaced)</option>
              </select>
            </div>
            <p className={styles.hint}>
              2-cell clip inserts that cross each horizontal seam on full cells, locking
              the two tiles together. Auto = ~1 bridge every 200 mm of seam length.
            </p>
          </div>
        )}

        <div className={styles.group}>
          <div className={styles.groupTitle}>Wall mounts</div>
          <div className={styles.field}>
            <label>Total</label>
            <select
              value={wallMountsTotal === undefined ? "auto" : String(wallMountsTotal)}
              onChange={(e) => {
                const v = e.target.value;
                setWallMountsTotal(v === "auto" ? undefined : Number(v));
              }}
            >
              <option value="auto">Auto (structural minimum)</option>
              <option value="0">0 (none)</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="6">6</option>
              <option value="8">8</option>
            </select>
          </div>
          <p className={styles.hint}>
            Countersunk M3 inserts that screw the whole panel to the wall (counted
            globally, not per tile). Auto = 1 on small panels (&lt;200 mm), otherwise
            max(2, ceil(longest_side / 400 mm)) — the structural minimum to hold the
            panel hung without bending. Bump up to add support on the perimeter.
          </p>
          <div className={styles.field}>
            <label style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={mergeMountsWithClips}
                onChange={(e) => setMergeMountsWithClips(e.target.checked)}
                style={{ width: "auto", marginRight: 6 }}
              />
              Merge into clip clusters
            </label>
          </div>
          <p className={styles.hint}>
            When a wall mount falls on a cluster cell, fold the screw hole into that cell
            so one printed part both locks the seam and fixes the panel to the wall.
            Fewer pieces, cleaner look.
          </p>
        </div>

        <div className={styles.group}>
          <div className={styles.groupTitle}>Insert variants</div>
          <div className={styles.field}>
            <label>Clip default</label>
            <select
              value={defaultClipVariant}
              onChange={(e) => setDefaultClipVariant(e.target.value as CellVariant)}
            >
              {ALL_CELL_VARIANTS.map((v) => (
                <option key={v} value={v}>
                  {CELL_VARIANT_LABELS[v]}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label>Wall-mount default</label>
            <select
              value={defaultMountVariant}
              onChange={(e) => setDefaultMountVariant(e.target.value as CellVariant)}
            >
              {ALL_CELL_VARIANTS.map((v) => (
                <option key={v} value={v}>
                  {CELL_VARIANT_LABELS[v]}
                </option>
              ))}
            </select>
          </div>
          <p className={styles.hint}>
            Defaults apply to every cell of every insert. Override individual cells below
            (the bolt-bearing cell is your choice — defaults to the cell where a wall mount
            was merged into the cluster).
          </p>
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "#b8b8c2" }}>
              Per-cell overrides ({Object.keys(cellOverrides).length})
            </summary>
            <div style={{ marginTop: 8, maxHeight: 280, overflowY: "auto", fontSize: 11 }}>
              {scene.inserts.length === 0 && (
                <p className={styles.hint}>No inserts yet.</p>
              )}
              {scene.inserts.map((ins) => (
                <div key={ins.id} style={{ marginBottom: 8 }}>
                  <div style={{ color: "#8a8a96", marginBottom: 2 }}>
                    {ins.id} ({ins.cellCount} cell{ins.cellCount > 1 ? "s" : ""})
                  </div>
                  {ins.spec.centers.map((_, ci) => {
                    const key = `${ins.id}:${ci}`;
                    const value = ins.variants[ci];
                    const isOverride = key in cellOverrides;
                    return (
                      <div
                        key={ci}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          marginBottom: 2,
                        }}
                      >
                        <span style={{ width: 38, color: "#8a8a96" }}>cell {ci}</span>
                        <select
                          value={value}
                          onChange={(e) => {
                            setCellOverrides((prev) => ({
                              ...prev,
                              [key]: e.target.value as CellVariant,
                            }));
                          }}
                          style={{ flex: 1, fontSize: 11, padding: "2px 4px" }}
                        >
                          {ALL_CELL_VARIANTS.map((v) => (
                            <option key={v} value={v}>
                              {CELL_VARIANT_LABELS[v]}
                            </option>
                          ))}
                        </select>
                        {isOverride && (
                          <button
                            type="button"
                            onClick={() => {
                              setCellOverrides((prev) => {
                                const next = { ...prev };
                                delete next[key];
                                return next;
                              });
                            }}
                            style={{
                              fontSize: 10,
                              padding: "1px 6px",
                              background: "#2e2e38",
                              color: "#b8b8c2",
                              border: "1px solid #3a3a48",
                              borderRadius: 3,
                              cursor: "pointer",
                            }}
                            title="Reset to default"
                          >
                            ↺
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {Object.keys(cellOverrides).length > 0 && (
                <button
                  type="button"
                  onClick={() => setCellOverrides({})}
                  style={{
                    marginTop: 4,
                    width: "100%",
                    padding: 4,
                    background: "#2e2e38",
                    color: "#b8b8c2",
                    border: "1px solid #3a3a48",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  Reset all overrides
                </button>
              )}
            </div>
          </details>
        </div>
          </Modal>
        )}

        {openModal === "stats" && (
          <Modal title="Stats" onClose={() => setOpenModal(null)}>
        <div className={styles.stats}>
          <div>
            Shape: <b>{shape.mode}</b>
          </div>
          <div>
            Holes: <b>{scene.cells.length}</b>
          </div>
          <div>
            Tiles: <b>{scene.tileCount}</b>
            {scene.tileCount > 1 && (
              <span style={{ color: "#8a8a96" }}>
                {" "}
                ({scene.tiles
                  .map((t) => `${t.bbox.width.toFixed(0)}x${t.bbox.height.toFixed(0)}`)
                  .join(", ")})
              </span>
            )}
          </div>
          {scene.seamCount > 0 && (
            <div>
              Seam cells: <b>{scene.seamCount}</b>, clip inserts <b>{scene.clipCount}</b>
              {scene.insertDistribution && (
                <span style={{ color: "#8a8a96" }}> ({scene.insertDistribution})</span>
              )}
            </div>
          )}
          {(scene.mountCount > 0 || scene.mergedCount > 0) && (
            <div>
              Wall mounts: <b>{scene.mountCount + scene.mergedCount}</b>{" "}
              <span style={{ color: "#8a8a96" }}>
                ({wallMountsTotal === undefined ? "auto" : `${wallMountsTotal} total`}, M3 countersunk
                {scene.mergedCount > 0 && `, ${scene.mergedCount} merged into clusters`})
              </span>
            </div>
          )}
          <div>
            Print plates: <b>{scene.beds.length}</b>
          </div>
          <div>
            Triangles: <b>{scene.triangles}</b>
          </div>
          <div className={fits ? styles.ok : styles.warn}>
            {fits
              ? subdivided
                ? "All tiles fit; assemble them to reproduce the wall."
                : "Fits the selected bed."
              : scene.tileCount === 0
                ? "Need at least 3 vertices for a valid shape."
                : "Some tiles exceed the bed: pick a larger bed or shrink the wall."}
          </div>
        </div>
          </Modal>
        )}

        {openModal === "display" && (
          <Modal title="Display" onClose={() => setOpenModal(null)}>
            <div className={styles.group}>
              <div className={styles.groupTitle}>Print colours</div>
              <p className={styles.hint} style={{ marginTop: 0, marginBottom: 12 }}>
                Applied when the viewer is in <b>Print</b> view mode. Pick filament
                colours to preview the assembled wall as it will look once
                printed.
              </p>
              <ColorRow
                label="Wall"
                color={printWallColor}
                onChange={setPrintWallColor}
              />
              <ColorRow
                label="Inserts"
                color={printInsertColor}
                onChange={setPrintInsertColor}
              />
            </div>
          </Modal>
        )}
        {openModal === "agent" && (
          <Modal title="Agent" onClose={() => setOpenModal(null)}>
            <AgentPanel context={agentContext} onToolCall={handleAgentTool} />
          </Modal>
        )}

        <div className={styles.actionBar}>
          <button
            className={styles.button}
            onClick={() => setGenerateTrigger((n) => n + 1)}
            disabled={computing}
            style={{
              background: isDirty && !computing ? "#3a6dff" : undefined,
              opacity: computing ? 0.6 : 1,
            }}
          >
            {computing
              ? progress
                ? `Generating ${progress.current} (${progress.done}/${progress.total})`
                : "Generating…"
              : appliedSignature === null
                ? "Generate"
                : isDirty
                  ? "Generate (params changed)"
                  : "Regenerate"}
          </button>
          <button
            className={styles.button}
            onClick={handleDownloadStls}
            disabled={scene.tileCount === 0}
            style={{ opacity: scene.tileCount === 0 ? 0.5 : 1 }}
          >
            {subdivided ? "Download STLs (ZIP)" : "Download STL"}
          </button>
          {scene.beds.length > 0 && (
            <button
              className={styles.buttonSecondary}
              onClick={handleDownloadThreeMf}
            >
              Download print plates (3MF)
            </button>
          )}
          {fits && scene.tileCount > 0 && !computing && (
            <span className={styles.actionStatus}>
              {scene.tileCount} {scene.tileCount === 1 ? "tile" : "tiles"} ·{" "}
              {scene.beds.length} {scene.beds.length === 1 ? "plate" : "plates"} ·{" "}
              {scene.triangles.toLocaleString()} tris
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className={styles.field}>
      <label>{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );
}

// Floating modal panel. Anchored top-left next to the toolbar, scrollable
// body, header with title + close X. Stays fixed to its anchor — we don't
// implement dragging (Printables doesn't either).
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.modal} role="dialog" aria-label={title}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>{title}</h2>
        <button
          type="button"
          className={styles.modalClose}
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className={styles.modalBody}>{children}</div>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`${styles.toolbarBtn} ${active ? styles.toolbarBtnActive : ""}`}
    >
      {children}
    </button>
  );
}

// 18×18 line icons — minimal stroke style matching the Viewer toolbar.
function SetupIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h13" />
      <circle cx="19" cy="6" r="2" />
      <path d="M3 12h6" />
      <circle cx="12" cy="12" r="2" />
      <path d="M14 12h7" />
      <path d="M3 18h10" />
      <circle cx="16" cy="18" r="2" />
      <path d="M18 18h3" />
    </svg>
  );
}

function InsertsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z" />
      <path d="M12 8 L16 10.5 L16 15.5 L12 18 L8 15.5 L8 10.5 Z" />
    </svg>
  );
}

// Row used in the Display modal: a labelled colour swatch that opens the
// browser-native colour picker on click. The native input is layered on
// top of the swatch with opacity:0 so the swatch's background shows the
// current value while the click still lands on the input.
function ColorRow({
  label,
  color,
  onChange,
}: {
  label: string;
  color: string;
  onChange: (c: string) => void;
}) {
  return (
    <label
      className={styles.field}
      style={{ cursor: "pointer" }}
      title={`${label} colour (${color})`}
    >
      <span>{label}</span>
      <span
        style={{
          width: 130,
          height: 26,
          background: color,
          border: "1px solid rgba(255,255,255,0.18)",
          position: "relative",
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        <input
          type="color"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0,
            cursor: "pointer",
            border: "none",
            padding: 0,
          }}
        />
      </span>
    </label>
  );
}

function DisplayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="6.5" r="1.6" fill="currentColor" />
      <circle cx="6.5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="17.5" r="1.6" fill="currentColor" />
      <circle cx="17.5" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20 L4 4" />
      <path d="M4 20 L20 20" />
      <rect x="7" y="13" width="3" height="6" />
      <rect x="12" y="9" width="3" height="10" />
      <rect x="17" y="6" width="3" height="13" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12c0 4.5-4 8-9 8-1.4 0-2.7-.3-3.9-.8L3 21l1.4-4.5C3.5 15.2 3 13.6 3 12c0-4.5 4-8 9-8s9 3.5 9 8Z" />
      <circle cx="9" cy="12" r="0.8" fill="currentColor" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
      <circle cx="15" cy="12" r="0.8" fill="currentColor" />
    </svg>
  );
}
