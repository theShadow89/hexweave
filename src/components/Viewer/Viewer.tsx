"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, SSAO } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import { Box3, DoubleSide, FrontSide, PerspectiveCamera, Plane, Sphere, Vector3, type BufferGeometry, type Group } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Mesh } from "@/types";
import { meshToGeometry } from "@/lib/three/meshToGeometry";

export type PieceCategory = "tile" | "clip" | "bridge" | "mount";

export interface ColoredMesh {
  key: string;
  mesh: Mesh;
  /** Colour used in `colors` view mode. Ignored in print / exploded modes. */
  color: string;
  /** Category drives the print colour and the explode strategy. */
  category: PieceCategory;
  opacity?: number;
}

export type ViewMode = "colors" | "print" | "exploded";

// Defaults for the "print" mode colour pickers, exported so the Display
// modal in page.tsx can seed its state. Two distinct colours so the
// assembled wall preview reads as it would from common PETG/PLA
// filament combinations (orange wall, black inserts).
export const DEFAULT_PRINT_WALL_COLOR = "#e36b27";
export const DEFAULT_PRINT_INSERT_COLOR = "#1f2228";

// Exploded view tuning.
//   TILE_SPREAD: how far each tile drifts away from the wall centre,
//     as a fraction of its distance to that centre. Small value → tiles
//     stay close (just enough gap to read them as separate pieces).
//   INSERT_LIFT: how far inserts float above the panel face (in mm of
//     panel-depth axis, which maps to world-up via the group rotation).
const TILE_SPREAD = 0.15;
const INSERT_LIFT = 60;

// Compute the geometry's centroid lazily. We use it both as the per-piece
// fly-out direction (exploded mode) and as a stable position offset.
function useGeometryCentroid(geometry: BufferGeometry) {
  return useMemo(() => {
    geometry.computeBoundingBox();
    const c = new Vector3();
    geometry.boundingBox?.getCenter(c);
    return c;
  }, [geometry]);
}

function Piece({
  mesh,
  color,
  category,
  opacity,
  xray,
  viewMode,
  wallCenter,
  printWallColor,
  printInsertColor,
}: {
  mesh: Mesh;
  color: string;
  category: PieceCategory;
  opacity?: number;
  xray: boolean;
  viewMode: ViewMode;
  /** Centroid of the wall (mean of all tile centroids) in mesh-local
   *  coords. Reference point for the radial tile spread in exploded
   *  view. */
  wallCenter: Vector3;
  /** User-selectable print colours, only used in `print` view mode. */
  printWallColor: string;
  printInsertColor: string;
}) {
  const geometry = useMemo(() => meshToGeometry(mesh), [mesh]);
  const centroid = useGeometryCentroid(geometry);
  const baseOpacity = opacity ?? 1;

  // Colour resolution by view mode:
  //   colors   → use the per-piece colour from props (tile palette /
  //              insert-type accent)
  //   print    → user-chosen wall colour for tiles, user-chosen insert
  //              colour for everything else (clip / bridge / mount)
  //   exploded → keep per-piece colour so each tile/insert stays
  //              distinguishable at a glance when scattered
  const renderColor =
    viewMode === "print"
      ? category === "tile"
        ? printWallColor
        : printInsertColor
      : color;

  // Position offset for exploded view.
  //   tile  → drift in the panel plane (local X = world X, local Y
  //           lateral after the group's +π/2 X rotation). z=0 keeps the
  //           tile co-planar with the rest of the wall.
  //   insert→ stays in place laterally, lifts along local −Z so the
  //           pieces float UP in world space (world Y = −local Z under
  //           the +π/2 default rotation). All inserts form a SEPARATE
  //           LAYER above the wall — clear "two sections" assembly view.
  const offset = useMemo<[number, number, number]>(() => {
    if (viewMode !== "exploded") return [0, 0, 0];
    if (category === "tile") {
      return [
        (centroid.x - wallCenter.x) * TILE_SPREAD,
        (centroid.y - wallCenter.y) * TILE_SPREAD,
        0,
      ];
    }
    // Insert: keep XY position relative to its host cell, lift toward camera.
    return [0, 0, -INSERT_LIFT];
  }, [viewMode, category, centroid, wallCenter]);

  return (
    <mesh geometry={geometry} position={offset} castShadow={!xray} receiveShadow={!xray}>
      <meshStandardMaterial
        color={renderColor}
        side={xray ? DoubleSide : FrontSide}
        metalness={0}
        roughness={xray ? 0.5 : 0.85}
        flatShading
        transparent={xray || baseOpacity < 1}
        opacity={xray ? Math.min(0.32, baseOpacity) : baseOpacity}
        depthWrite={!xray}
      />
    </mesh>
  );
}

// Re-computes the world-space bbox of the model group and points the
// OrbitControls' `target` at its centre. Runs once on mount and again
// whenever `depKey` changes (i.e. meshes change or view mode toggles).
// This is what makes the rotation pivot stick to the model's actual
// visual centre — without it, OrbitControls orbits a fixed point and
// the model swings around it instead of spinning in place.
function PivotTracker({
  groupRef,
  controlsRef,
  depKey,
}: {
  groupRef: React.RefObject<Group | null>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  depKey: string;
}) {
  useEffect(() => {
    const g = groupRef.current;
    const c = controlsRef.current;
    if (!g || !c) return;
    // Defer one frame so child meshes have committed their geometry +
    // position offsets before we measure the bbox.
    const id = requestAnimationFrame(() => {
      const box = new Box3().setFromObject(g);
      if (box.isEmpty()) return;
      const centre = box.getCenter(new Vector3());
      c.target.copy(centre);
      c.update();
    });
    return () => cancelAnimationFrame(id);
  }, [groupRef, controlsRef, depKey]);
  return null;
}

// Auto-fit the camera distance to the model's bounding box. Runs only when
// `fitKey` changes (= the meshes array reference changes — i.e. a new
// generation or initial load). View-mode / flip toggles do NOT re-fit, so
// the user's manual zoom is preserved across UI changes; only a full
// re-generate (which can drastically change the model size) resets it.
//
// Algorithm: take the bbox sphere radius, then place the camera at a distance
// where the sphere fits within the FOV with some margin. Direction is
// preserved from the current camera→target vector, so the user's last view
// angle is kept; on first mount (no prior direction) we use a sensible
// isometric default.
// 1.15 = "tight" framing: the bounding sphere just touches the FOV cone edge
// with a slim breathing-room margin. Higher values waste screen space (model
// looks tiny); the previous 1.8 left the wall at ~55% of view height which
// felt zoomed-out for users who expect a Printables-like close framing.
const FIT_MARGIN = 1.15;
const DEFAULT_VIEW_DIR = new Vector3(0.5, 0.65, 0.7).normalize();
function CameraFitter({
  groupRef,
  controlsRef,
  fitKey,
}: {
  groupRef: React.RefObject<Group | null>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  fitKey: string;
}) {
  const { camera } = useThree();
  useEffect(() => {
    const g = groupRef.current;
    const c = controlsRef.current;
    if (!g || !c || !(camera instanceof PerspectiveCamera)) return;
    const id = requestAnimationFrame(() => {
      const box = new Box3().setFromObject(g);
      if (box.isEmpty()) return;
      const centre = box.getCenter(new Vector3());
      const sphere = box.getBoundingSphere(new Sphere());
      const radius = sphere.radius;
      if (!Number.isFinite(radius) || radius <= 0) return;
      // distance = r / sin(fov/2) gives the camera distance at which the
      // bounding sphere exactly fills the vertical FOV. Multiply by FIT_MARGIN
      // so the model has breathing room.
      const fovRad = (camera.fov * Math.PI) / 180;
      const distance = (radius / Math.sin(fovRad / 2)) * FIT_MARGIN;
      let dir = camera.position.clone().sub(c.target);
      if (dir.lengthSq() < 1) {
        dir.copy(DEFAULT_VIEW_DIR);
      } else {
        dir.normalize();
      }
      camera.position.copy(centre).addScaledVector(dir, distance);
      c.target.copy(centre);
      c.update();
    });
    return () => cancelAnimationFrame(id);
  }, [camera, groupRef, controlsRef, fitKey]);
  return null;
}

// Global cutting plane via gl.clippingPlanes — clips every material in
// the scene without per-mesh wiring. Normal=(0,-1,0): increasing y
// reveals the bottom (above the plane is removed).
function ClipPlaneController({ enabled, y }: { enabled: boolean; y: number }) {
  const { gl } = useThree();
  const plane = useMemo(() => new Plane(new Vector3(0, -1, 0), y), [y]);
  useEffect(() => {
    gl.clippingPlanes = enabled ? [plane] : [];
    gl.localClippingEnabled = false;
    return () => {
      gl.clippingPlanes = [];
    };
  }, [gl, enabled, plane]);
  return null;
}

export default function Viewer({
  meshes,
  printWallColor = DEFAULT_PRINT_WALL_COLOR,
  printInsertColor = DEFAULT_PRINT_INSERT_COLOR,
}: {
  meshes: ColoredMesh[];
  /** Wall colour applied in `print` view mode. Controlled from page.tsx
   *  (Display modal). Defaults preserve the previous behaviour if the
   *  Viewer is used stand-alone without a host providing them. */
  printWallColor?: string;
  printInsertColor?: string;
}) {
  const [clipEnabled, setClipEnabled] = useState(false);
  const [xray, setXray] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("colors");
  const [flipped, setFlipped] = useState(false);
  // Default rotation +π/2 puts the panel's depth (panel-local z=0..8) onto
  // world Y range ~ -8..0, plus the flange protrusion up to ~+2.5. Default
  // slice at world Y=-4 cuts through the middle of the panel (mid-depth).
  const [clipY, setClipY] = useState(-4);
  const groupRef = useRef<Group | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  // wallCenter = mean of tile-piece centroids. The tile centroid is the
  // bbox centre of its mesh in mesh-local coords (= world coords, since
  // each tile mesh is built from its own outline in world coords). We
  // average across tiles so non-square subdivisions still get a sensible
  // centre. Inserts are excluded — they cluster near the seams and
  // would skew the centre toward them.
  const wallCenter = useMemo(() => {
    const tiles = meshes.filter((m) => m.category === "tile");
    if (tiles.length === 0) return new Vector3();
    const acc = new Vector3();
    for (const t of tiles) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      const p = t.mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      acc.x += (minX + maxX) / 2;
      acc.y += (minY + maxY) / 2;
      acc.z += (minZ + maxZ) / 2;
    }
    acc.divideScalar(tiles.length);
    return acc;
  }, [meshes]);

  const cycleViewMode = () =>
    setViewMode((m) => (m === "colors" ? "print" : m === "print" ? "exploded" : "colors"));

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Canvas
        // Initial camera position is OUTSIDE the bbox of any reasonable wall
        // (≤ ~1.5 m). The CameraFitter overrides this once meshes load.
        // far=20000 prevents wall edges from getting clipped at fit distance
        // when the wall is large (default three.js far=2000 is too tight; a
        // 1.5 m wall sits ~3 m from the camera after fit, which would clip).
        camera={{ position: [600, 800, 900], fov: 45, near: 0.1, far: 20000 }}
        gl={{
          antialias: true,
          alpha: false,
          // Prefer the discrete/high-perf GPU on multi-GPU systems.
          powerPreference: "high-performance",
          // Allow software fallback if the major-perf-caveat WebGL is the only
          // option — better a slow scene than a black screen with an error.
          failIfMajorPerformanceCaveat: false,
          // Don't preserve the drawing buffer (default), but make sure the
          // context is at least requested cleanly.
          preserveDrawingBuffer: false,
        }}
        // UNIFORM dark backdrop, no gradient. A top→bottom gradient
        // creates a perceived horizon that stays vertical while the
        // camera tilts → the brain reads the world as "tilting", not
        // the model. Flat colour removes that cue entirely: with nothing
        // else in the scene (no ground, no grid), rotation feels purely
        // like spinning the piece in your hand.
        style={{ background: "#16181d" }}
      >
        {/* Lighting tuned for the Printables look: warm key from upper
            front-right hits the lit faces, cool fill catches the shadow
            side, hemisphere fills neutral ambient. No shadow casting now
            that there's no ground plane to receive shadows — flat
            shading on the faces does the visual work. */}
        <hemisphereLight args={["#e8eaf0", "#1d2026", 0.55]} />
        <directionalLight position={[150, 280, 200]} intensity={1.4} />
        <directionalLight position={[-180, 140, -60]} intensity={0.5} />
        <directionalLight position={[0, 80, -300]} intensity={0.3} />

        {/* Panel coords have Z as depth: z=0 = flange-pocket face (OUTER,
            user-facing — flange caps protrude OUT from this face), z=8 =
            rear-groove face (WALL-facing, against the wall, hidden once
            mounted). Default rotation +π/2 around X puts the flange face
            UP toward the camera so the user sees the OUTER face first
            (the side they care about: head pockets, flange caps). `flipped`
            switches to −π/2, putting the rear-groove WALL face up. */}
        <group ref={groupRef} rotation={[(flipped ? -1 : 1) * (Math.PI / 2), 0, 0]}>
          {meshes.map((m) => (
            <Piece
              key={m.key}
              mesh={m.mesh}
              color={m.color}
              category={m.category}
              opacity={m.opacity}
              xray={xray}
              viewMode={viewMode}
              wallCenter={wallCenter}
              printWallColor={printWallColor}
              printInsertColor={printInsertColor}
            />
          ))}
        </group>
        <PivotTracker
          groupRef={groupRef}
          controlsRef={controlsRef}
          depKey={`${meshes.length}:${viewMode}:${flipped}`}
        />
        <CameraFitter
          groupRef={groupRef}
          controlsRef={controlsRef}
          fitKey={`${meshes.length}:${meshes.map((m) => m.key).join(",")}`}
        />

        {/* No ground shadows / no grid: the scene is pure void around the
            model. This is what makes rotation feel like the MODEL spins
            (instead of "the whole stage tilts"). Matches Printables. */}

        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.8}
          zoomSpeed={0.9}
          minDistance={40}
          // Generous max so large walls (1+ m) fit comfortably. Without this
          // OrbitControls clamps the auto-fit camera to maxDistance and the
          // camera ends up INSIDE the model.
          maxDistance={10000}
          // zoomToCursor: scroll-wheel zoom centres on the point under the
          // cursor instead of the orbit target. Lets the user dive into a
          // specific cell/insert by pointing at it. Three.js OrbitControls
          // shifts the target as part of the zoom, so subsequent rotations
          // pivot around the new target — that's the expected UX.
          zoomToCursor
          // Pan disabled — model stays centred. The target is set dynamically
          // by PivotTracker (bbox centre) and shifted further by zoomToCursor.
          enablePan={false}
        />
        <ClipPlaneController enabled={clipEnabled} y={clipY} />

        {/* SSAO darkens recessed geometry. Disabled during X-ray (the
            depth-based AO algorithm misreads ghost geometry). */}
        {!xray && (
          <EffectComposer enableNormalPass multisampling={4}>
            <SSAO
              blendFunction={BlendFunction.MULTIPLY}
              samples={16}
              radius={8}
              intensity={20}
              bias={0.04}
              distanceThreshold={0.6}
              distanceFalloff={0.1}
              rangeThreshold={0.015}
              rangeFalloff={0.01}
              luminanceInfluence={0.5}
              color={undefined}
            />
          </EffectComposer>
        )}
      </Canvas>

      <ViewerToolbar
        clipEnabled={clipEnabled}
        clipY={clipY}
        xray={xray}
        viewMode={viewMode}
        flipped={flipped}
        onToggleClip={() => setClipEnabled((v) => !v)}
        onToggleXray={() => setXray((v) => !v)}
        onCycleViewMode={cycleViewMode}
        onClipY={setClipY}
        onToggleFlip={() => setFlipped((v) => !v)}
      />
    </div>
  );
}

function ViewerToolbar({
  clipEnabled,
  clipY,
  xray,
  viewMode,
  flipped,
  onToggleClip,
  onToggleXray,
  onCycleViewMode,
  onClipY,
  onToggleFlip,
}: {
  clipEnabled: boolean;
  clipY: number;
  xray: boolean;
  viewMode: ViewMode;
  flipped: boolean;
  onToggleClip: () => void;
  onToggleXray: () => void;
  onCycleViewMode: () => void;
  onClipY: (v: number) => void;
  onToggleFlip: () => void;
}) {
  // The view-mode button cycles colors → print → exploded → colors.
  // Title tells the user the NEXT mode, so the click is predictable.
  const viewModeLabel =
    viewMode === "colors" ? "Colors" : viewMode === "print" ? "Print" : "Exploded";
  const viewModeTitle =
    viewMode === "colors"
      ? "View: tile colors (click → print)"
      : viewMode === "print"
        ? "View: print orange (click → exploded)"
        : "View: exploded (click → tile colors)";
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        alignItems: "flex-end",
        userSelect: "none",
      }}
    >
      <LabeledToolbarButton
        active
        label={viewModeLabel}
        title={viewModeTitle}
        onClick={onCycleViewMode}
      >
        <ViewModeIcon mode={viewMode} />
      </LabeledToolbarButton>
      <LabeledToolbarButton
        active={flipped}
        label={flipped ? "Wall face" : "Outer face"}
        title={flipped ? "Show outer face (user-facing)" : "Show wall face (against wall)"}
        onClick={onToggleFlip}
      >
        <FlipIcon />
      </LabeledToolbarButton>
      <IconButton active={xray} onClick={onToggleXray} title="X-ray view">
        <XrayIcon />
      </IconButton>
      <IconButton active={clipEnabled} onClick={onToggleClip} title="Section view">
        <SectionIcon />
      </IconButton>
      {clipEnabled && (
        <div
          style={{
            marginTop: 4,
            padding: "8px 6px",
            background: "rgba(18,18,24,0.85)",
            border: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            backdropFilter: "blur(6px)",
          }}
        >
          <input
            type="range"
            // Range covers the model's world-Y extent after the +π/2 rotation:
            // panel depth maps to ~ -8..0 and the flange protrusion reaches
            // +2.5, with a small overscan above for clarity.
            min={-9}
            max={3}
            step={0.1}
            value={clipY}
            onChange={(e) => onClipY(Number(e.target.value))}
            style={{
              writingMode: "vertical-lr",
              direction: "rtl",
              width: 6,
              height: 120,
              cursor: "pointer",
            }}
          />
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", fontVariantNumeric: "tabular-nums" }}>
            {clipY.toFixed(1)}
          </span>
        </div>
      )}
    </div>
  );
}

// Wider variant of IconButton that shows a label next to the icon. Used for
// toolbar entries whose CURRENT state value is itself useful information
// (view mode, viewed face) — the user shouldn't have to hover to know which
// state is active.
function LabeledToolbarButton({
  active,
  label,
  title,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        height: 36,
        padding: "0 12px 0 8px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "rgba(18,18,24,0.85)",
        color: active ? "#ff8a3d" : "rgba(255,255,255,0.78)",
        border: `1px solid ${active ? "rgba(255,138,61,0.65)" : "rgba(255,255,255,0.10)"}`,
        cursor: "pointer",
        backdropFilter: "blur(6px)",
        transition: "color 120ms, border-color 120ms",
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        whiteSpace: "nowrap",
      }}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function IconButton({
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
      style={{
        width: 36,
        height: 36,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(18,18,24,0.85)",
        color: active ? "#ff8a3d" : "rgba(255,255,255,0.78)",
        border: `1px solid ${active ? "rgba(255,138,61,0.65)" : "rgba(255,255,255,0.10)"}`,
        cursor: "pointer",
        backdropFilter: "blur(6px)",
        transition: "color 120ms, border-color 120ms",
      }}
    >
      {children}
    </button>
  );
}

function SectionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="17" height="17" />
      <path d="M3.5 12h17" strokeDasharray="2 2" />
    </svg>
  );
}

// Cycle icon — three small squares that visually morph through the
// states: clustered (colors) → overlapping (print) → spread (exploded).
function ViewModeIcon({ mode }: { mode: ViewMode }) {
  if (mode === "colors") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="8" height="8" />
        <rect x="13" y="3" width="8" height="8" />
        <rect x="3" y="13" width="8" height="8" />
        <rect x="13" y="13" width="8" height="8" />
      </svg>
    );
  }
  if (mode === "print") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" />
        <path d="M4 12h16" />
        <path d="M12 4v16" />
      </svg>
    );
  }
  // exploded
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="7" height="7" />
      <rect x="15" y="2" width="7" height="7" />
      <rect x="2" y="15" width="7" height="7" />
      <rect x="15" y="15" width="7" height="7" />
      <path d="M10 5.5h4" strokeDasharray="1.5 1.5" />
      <path d="M10 18.5h4" strokeDasharray="1.5 1.5" />
      <path d="M5.5 10v4" strokeDasharray="1.5 1.5" />
      <path d="M18.5 10v4" strokeDasharray="1.5 1.5" />
    </svg>
  );
}

// Flip icon — two stacked arrows pointing opposite directions, hinting
// at rotation around a horizontal axis (panel face flip).
function FlipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h13" />
      <path d="M13 5l3 3l-3 3" />
      <path d="M21 16H8" />
      <path d="M11 13l-3 3l3 3" />
    </svg>
  );
}

function XrayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="M3 12h2" />
      <path d="M19 12h2" />
      <path d="M12 3v2" />
      <path d="M12 19v2" />
    </svg>
  );
}
