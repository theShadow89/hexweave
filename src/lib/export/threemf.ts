import { zipSync, strToU8 } from "fflate";
import type { Mesh } from "@/types";

export interface ThreeMfObject {
  /** Stable id used as 3MF object id. Must be > 0 and unique within the file. */
  id: number;
  /** Mesh in millimetres, already recentered so its min corner is at origin. */
  mesh: Mesh;
  /** Translation applied via the build item (mm). */
  translate: [number, number, number];
  /** Rotation in degrees around the Z axis (0 or 90 are supported). */
  rotateDegZ?: 0 | 90;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function formatNum(n: number): string {
  // Compact, deterministic, slicer-friendly.
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1e-6) return "0";
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/** 3MF transform: 12 numbers in column-major (col1, col2, col3, col4=translation). */
function transformAttr(translate: [number, number, number], rotateDegZ: 0 | 90 = 0): string {
  const tx = translate[0];
  const ty = translate[1];
  const tz = translate[2];
  if (rotateDegZ === 0) {
    return `1 0 0 0 1 0 0 0 1 ${formatNum(tx)} ${formatNum(ty)} ${formatNum(tz)}`;
  }
  // 90° CCW around Z: column1 = (0, 1, 0), column2 = (-1, 0, 0), column3 = (0, 0, 1).
  return `0 1 0 -1 0 0 0 0 1 ${formatNum(tx)} ${formatNum(ty)} ${formatNum(tz)}`;
}

function meshXml(mesh: Mesh): string {
  const verts: string[] = [];
  const tris: string[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    verts.push(`<vertex x="${formatNum(p[i])}" y="${formatNum(p[i + 1])}" z="${formatNum(p[i + 2])}"/>`);
  }
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    tris.push(`<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`);
  }
  return `<mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh>`;
}

/** Serialise the given build objects into a 3MF archive. */
export function buildThreeMf(objects: ThreeMfObject[]): Uint8Array {
  const objectXmls: string[] = [];
  const itemXmls: string[] = [];
  for (const obj of objects) {
    objectXmls.push(`<object id="${obj.id}" type="model">${meshXml(obj.mesh)}</object>`);
    itemXmls.push(`<item objectid="${obj.id}" transform="${transformAttr(obj.translate, obj.rotateDegZ ?? 0)}"/>`);
  }
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${objectXmls.join("")}</resources>` +
    `<build>${itemXmls.join("")}</build>` +
    `</model>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "3D/3dmodel.model": strToU8(model),
  };
  return zipSync(files, { level: 6 });
}
