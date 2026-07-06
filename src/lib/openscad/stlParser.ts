import type { Mesh } from "@/types";

const FLOAT_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/**
 * Parse an ASCII or binary STL into our internal indexed Mesh.
 *
 * OpenSCAD's `renderToStl` returns ASCII STL with one triangle per `facet`.
 * Triangles share vertices on the seam between adjacent faces, so we dedupe
 * positions by a quantised hash (snap to 1e-5 mm) and emit indices.
 *
 * Binary STL is also supported because OpenSCAD's `--export-format=binstl`
 * is faster for huge meshes; we may switch to it once the pipeline is stable.
 */
export function parseStl(data: string | Uint8Array): Mesh {
  if (data instanceof Uint8Array) {
    if (isAsciiStl(data)) {
      return parseAsciiStl(bytesToString(data));
    }
    return parseBinaryStl(data);
  }
  return parseAsciiStl(data);
}

function isAsciiStl(bytes: Uint8Array): boolean {
  // ASCII STL begins with "solid " (5 bytes + space). Binary STL has an
  // 80-byte header that *can* start with "solid " too, so additionally
  // check the triangle count against the file size.
  const head = bytesToString(bytes.subarray(0, Math.min(bytes.length, 5)));
  if (head !== "solid") return false;
  if (bytes.length < 84) return true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  return expected !== bytes.length;
}

function bytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function parseAsciiStl(text: string): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const lookup = new Map<string, number>();

  const lines = text.split("\n");
  let i = 0;
  // Buffer the 3 indices of the current triangle. Drop the triangle if any
  // two of its vertices collapse to the same dedupe key (degenerate triangle
  // with zero area). Manifold and CGAL sometimes emit these at convex corners
  // — they're mathematically invisible but trip watertight checks that count
  // edges per (a,b) pair.
  let triBuf: number[] = [];
  const flushTriangle = () => {
    if (triBuf.length === 3) {
      const [a, b, c] = triBuf;
      if (a !== b && b !== c && a !== c) {
        indices.push(a, b, c);
      }
    }
    triBuf = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("outer loop")) {
      flushTriangle();
    } else if (line.includes("vertex")) {
      const matches = line.match(FLOAT_RE);
      if (!matches || matches.length < 3) {
        i++;
        continue;
      }
      const x = parseFloat(matches[matches.length - 3]);
      const y = parseFloat(matches[matches.length - 2]);
      const z = parseFloat(matches[matches.length - 1]);
      triBuf.push(addVertex(positions, lookup, x, y, z));
    }
    i++;
  }
  flushTriangle();

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

function parseBinaryStl(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = view.getUint32(80, true);
  const positions: number[] = [];
  const indices: number[] = [];
  const lookup = new Map<string, number>();

  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    offset += 12; // skip normal
    const tri: number[] = [];
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      tri.push(addVertex(positions, lookup, x, y, z));
      offset += 12;
    }
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) {
      indices.push(tri[0], tri[1], tri[2]);
    }
    offset += 2; // skip attribute byte count
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

function addVertex(
  positions: number[],
  lookup: Map<string, number>,
  x: number,
  y: number,
  z: number,
): number {
  const key = quantKey(x, y, z);
  const existing = lookup.get(key);
  if (existing !== undefined) return existing;
  const idx = positions.length / 3;
  positions.push(x, y, z);
  lookup.set(key, idx);
  return idx;
}

function quantKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e5)}_${Math.round(y * 1e5)}_${Math.round(z * 1e5)}`;
}
