import { BufferAttribute, BufferGeometry } from "three";
import type { Mesh } from "@/types";

export function meshToGeometry(mesh: Mesh): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geom.setIndex(new BufferAttribute(mesh.indices, 1));
  geom.computeVertexNormals();
  return geom;
}
