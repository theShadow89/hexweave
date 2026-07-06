import type { Mesh } from "@/types";

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export function meshBounds3(mesh: Mesh): Bounds3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2];
    if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function translateMesh(mesh: Mesh, dx: number, dy: number, dz = 0): Mesh {
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    out[i] = mesh.positions[i] + dx;
    out[i + 1] = mesh.positions[i + 1] + dy;
    out[i + 2] = mesh.positions[i + 2] + dz;
  }
  return { positions: out, indices: mesh.indices };
}

/** Move a mesh so its XY bbox.min sits at (0,0) and bbox.min.z at 0. */
export function recenterToOrigin(mesh: Mesh): { mesh: Mesh; bounds: Bounds3 } {
  const b = meshBounds3(mesh);
  return {
    mesh: translateMesh(mesh, -b.min[0], -b.min[1], -b.min[2]),
    bounds: b,
  };
}

/** Rotate a mesh 90° counter-clockwise around the Z axis (about origin). */
export function rotate90Z(mesh: Mesh): Mesh {
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    out[i] = -y;
    out[i + 1] = x;
    out[i + 2] = mesh.positions[i + 2];
  }
  return { positions: out, indices: mesh.indices };
}

/**
 * Concatenate several meshes into one. Each piece keeps its own triangulation;
 * shared faces (e.g. two stacked extrusions touching at a Z plane) are not
 * merged, so the combined mesh is a union of solids rather than a manifold.
 * Slicers handle this fine and treat the pieces as a single object.
 */
export function concatMeshes(...meshes: Mesh[]): Mesh {
  if (meshes.length === 1) return meshes[0];
  let totalPos = 0;
  let totalIdx = 0;
  for (const m of meshes) {
    totalPos += m.positions.length;
    totalIdx += m.indices.length;
  }
  const positions = new Float32Array(totalPos);
  const indices = new Uint32Array(totalIdx);
  let posOffset = 0;
  let idxOffset = 0;
  for (const m of meshes) {
    positions.set(m.positions, posOffset);
    const vertOffset = posOffset / 3;
    for (let i = 0; i < m.indices.length; i++) {
      indices[idxOffset + i] = m.indices[i] + vertOffset;
    }
    posOffset += m.positions.length;
    idxOffset += m.indices.length;
  }
  return { positions, indices };
}
