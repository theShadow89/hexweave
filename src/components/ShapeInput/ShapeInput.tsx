"use client";

import { useMemo, useState } from "react";
import type { Polygon, Vec2 } from "@/types";
import styles from "./ShapeInput.module.css";
import { polygonsFromSvg } from "@/lib/shape/fromSvg";

export type ShapeMode = "rectangle" | "sides" | "vertices" | "svg" | "draw";

export interface ShapeState {
  mode: ShapeMode;
  rectangle: { width: number; height: number };
  sides: { count: number; length: number };
  vertices: { text: string };
  svg: { text: string; selected: number };
  draw: { points: Vec2[] };
}

export const DEFAULT_SHAPE_STATE: ShapeState = {
  mode: "rectangle",
  rectangle: { width: 400, height: 350 },
  sides: { count: 6, length: 120 },
  vertices: { text: "0 0\n200 0\n300 120\n200 240\n0 240" },
  svg: { text: "", selected: 0 },
  draw: { points: [] },
};

const TABS: Array<{ id: ShapeMode; label: string }> = [
  { id: "rectangle", label: "Rect" },
  { id: "sides", label: "Sides" },
  { id: "vertices", label: "Verts" },
  { id: "svg", label: "SVG" },
  { id: "draw", label: "Draw" },
];

export interface ShapeInputProps {
  state: ShapeState;
  onChange: (state: ShapeState) => void;
  /** Polygon parsed from current state in mm coords; empty when invalid. */
  parsedPolygon: Polygon;
}

export function ShapeInput({ state, onChange, parsedPolygon }: ShapeInputProps) {
  const set = <K extends keyof ShapeState>(key: K, value: ShapeState[K]) =>
    onChange({ ...state, [key]: value });

  return (
    <div>
      <div className={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${state.mode === tab.id ? styles.tabActive : ""}`}
            onClick={() => onChange({ ...state, mode: tab.id })}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {state.mode === "rectangle" && (
        <RectInputs
          value={state.rectangle}
          onChange={(rectangle) => set("rectangle", rectangle)}
        />
      )}
      {state.mode === "sides" && (
        <SidesInputs
          value={state.sides}
          onChange={(sides) => set("sides", sides)}
        />
      )}
      {state.mode === "vertices" && (
        <VerticesInput
          value={state.vertices}
          onChange={(vertices) => set("vertices", vertices)}
        />
      )}
      {state.mode === "svg" && (
        <SvgInput
          value={state.svg}
          onChange={(svg) => set("svg", svg)}
        />
      )}
      {state.mode === "draw" && (
        <DrawCanvas
          value={state.draw}
          onChange={(draw) => set("draw", draw)}
        />
      )}

      {parsedPolygon.length >= 3 && (
        <p className={styles.hint}>
          {parsedPolygon.length} vertices
          {state.mode !== "draw" ? ` · area ${polyArea(parsedPolygon).toFixed(0)} mm²` : ""}
        </p>
      )}
      {parsedPolygon.length < 3 && state.mode !== "rectangle" && (
        <p className={styles.warn}>Polygon needs at least 3 vertices.</p>
      )}
    </div>
  );
}

function polyArea(p: Polygon): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

function NumField({
  label,
  value,
  min,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
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
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );
}

function RectInputs({
  value,
  onChange,
}: {
  value: ShapeState["rectangle"];
  onChange: (v: ShapeState["rectangle"]) => void;
}) {
  return (
    <>
      <NumField
        label="Width (mm)"
        value={value.width}
        min={40}
        onChange={(width) => onChange({ ...value, width })}
      />
      <NumField
        label="Height (mm)"
        value={value.height}
        min={40}
        onChange={(height) => onChange({ ...value, height })}
      />
    </>
  );
}

function SidesInputs({
  value,
  onChange,
}: {
  value: ShapeState["sides"];
  onChange: (v: ShapeState["sides"]) => void;
}) {
  return (
    <>
      <NumField
        label="Sides"
        value={value.count}
        min={3}
        onChange={(count) => onChange({ ...value, count: Math.max(3, Math.round(count)) })}
      />
      <NumField
        label="Side length (mm)"
        value={value.length}
        min={20}
        onChange={(length) => onChange({ ...value, length })}
      />
      <p className={styles.hint}>Regular polygon with {value.count} equal sides.</p>
    </>
  );
}

function VerticesInput({
  value,
  onChange,
}: {
  value: ShapeState["vertices"];
  onChange: (v: ShapeState["vertices"]) => void;
}) {
  return (
    <>
      <p className={styles.hint}>One vertex per line: <code>x y</code> in mm.</p>
      <textarea
        className={styles.textarea}
        value={value.text}
        rows={8}
        spellCheck={false}
        onChange={(e) => onChange({ text: e.target.value })}
      />
    </>
  );
}

function SvgInput({
  value,
  onChange,
}: {
  value: ShapeState["svg"];
  onChange: (v: ShapeState["svg"]) => void;
}) {
  const polygons = useMemo(() => polygonsFromSvg(value.text), [value.text]);
  return (
    <>
      <p className={styles.hint}>
        Paste SVG with <code>&lt;polygon&gt;</code>, <code>&lt;polyline&gt;</code> or
        <code>&lt;path&gt;</code> (M/L/Z only). Y axis is flipped automatically.
      </p>
      <textarea
        className={styles.textarea}
        value={value.text}
        rows={7}
        spellCheck={false}
        placeholder='<svg><polygon points="0,0 200,0 200,150 0,150"/></svg>'
        onChange={(e) => onChange({ ...value, text: e.target.value })}
      />
      {polygons.length > 1 && (
        <div className={styles.field}>
          <label>Pick polygon</label>
          <select
            value={value.selected}
            onChange={(e) => onChange({ ...value, selected: Number(e.target.value) })}
          >
            {polygons.map((p, i) => (
              <option key={i} value={i}>
                #{i + 1} ({p.length} verts)
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

function DrawCanvas({
  value,
  onChange,
}: {
  value: ShapeState["draw"];
  onChange: (v: ShapeState["draw"]) => void;
}) {
  const [snap, setSnap] = useState(10);
  const widthMm = 600;
  const heightMm = 400;
  const viewBox = `0 0 ${widthMm} ${heightMm}`;
  return (
    <>
      <p className={styles.hint}>
        Click to add a vertex (snap {snap} mm). The polygon closes automatically.
      </p>
      <div className={styles.field}>
        <label>Snap (mm)</label>
        <input
          type="number"
          value={snap}
          min={1}
          step={1}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) setSnap(v);
          }}
        />
      </div>
      <svg
        className={styles.svgCanvas}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        onClick={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * widthMm;
          // Flip Y so the user draws in math coords (Y up).
          const y = heightMm - ((e.clientY - rect.top) / rect.height) * heightMm;
          const sx = Math.round(x / snap) * snap;
          const sy = Math.round(y / snap) * snap;
          onChange({ points: [...value.points, [sx, sy]] });
        }}
      >
        <defs>
          <pattern id="grid" width={snap * 5} height={snap * 5} patternUnits="userSpaceOnUse">
            <path
              d={`M ${snap * 5} 0 L 0 0 0 ${snap * 5}`}
              fill="none"
              stroke="#26262e"
              strokeWidth={0.5}
            />
          </pattern>
        </defs>
        <rect width={widthMm} height={heightMm} fill="#0e0e11" />
        <rect width={widthMm} height={heightMm} fill="url(#grid)" />
        {value.points.length > 0 && (
          <polygon
            points={value.points.map((p) => `${p[0]},${heightMm - p[1]}`).join(" ")}
            fill="#4b6bfb55"
            stroke="#4b6bfb"
            strokeWidth={1.5}
          />
        )}
        {value.points.map((p, i) => (
          <circle
            key={i}
            cx={p[0]}
            cy={heightMm - p[1]}
            r={3}
            fill={i === 0 ? "#f0a04b" : "#4b6bfb"}
          />
        ))}
      </svg>
      <button
        type="button"
        className={styles.smallBtn}
        onClick={() => onChange({ points: value.points.slice(0, -1) })}
        disabled={value.points.length === 0}
      >
        Undo last
      </button>
      <button
        type="button"
        className={styles.smallBtn}
        onClick={() => onChange({ points: [] })}
        disabled={value.points.length === 0}
        style={{ marginLeft: 4 }}
      >
        Clear
      </button>
    </>
  );
}
