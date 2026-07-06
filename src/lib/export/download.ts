import { zipSync, strToU8 } from "fflate";
import type { Mesh } from "@/types";
import { meshToBinaryStl } from "@/lib/export/stl";
import { buildThreeMf, type ThreeMfObject } from "@/lib/export/threemf";

export function downloadStl(mesh: Mesh, filename: string): void {
  const buffer = meshToBinaryStl(mesh);
  triggerDownload(new Blob([buffer], { type: "model/stl" }), withStlExt(filename));
}

export interface NamedMesh {
  name: string;
  mesh: Mesh;
}

/**
 * Download every mesh packed in a single zip. Each entry is a binary STL
 * named after the mesh; the slicer can ingest them all at once.
 */
export function downloadStlZip(meshes: NamedMesh[], zipName: string, notes?: string): void {
  const files: Record<string, Uint8Array> = {};
  for (const { name, mesh } of meshes) {
    files[withStlExt(name)] = new Uint8Array(meshToBinaryStl(mesh));
  }
  if (notes) files["README.txt"] = strToU8(notes);
  const zipped = zipSync(files, { level: 6 });
  triggerDownload(new Blob([zipped], { type: "application/zip" }), withZipExt(zipName));
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function withStlExt(name: string): string {
  return name.endsWith(".stl") ? name : `${name}.stl`;
}

function withZipExt(name: string): string {
  return name.endsWith(".zip") ? name : `${name}.zip`;
}

export interface ThreeMfBed {
  /** File-name-safe id, e.g. "plate_1". */
  name: string;
  objects: ThreeMfObject[];
}

/** Download a ZIP containing one .3mf per print plate plus an optional README. */
export function downloadThreeMfZip(
  beds: ThreeMfBed[],
  zipName: string,
  notes?: string,
): void {
  const files: Record<string, Uint8Array> = {};
  for (const bed of beds) {
    files[`${bed.name}.3mf`] = buildThreeMf(bed.objects);
  }
  if (notes) files["README.txt"] = strToU8(notes);
  const zipped = zipSync(files, { level: 6 });
  triggerDownload(new Blob([zipped], { type: "application/zip" }), withZipExt(zipName));
}
