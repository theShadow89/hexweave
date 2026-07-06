import type { Mesh } from "@/types";
import { parseStl } from "./stlParser";

/**
 * Singleton openscad-wasm loader. The package ships the WASM binary inlined
 * as base64 inside a single 13.9 MB ES module, so there is no separate `.wasm`
 * file to bundle — Turbopack just treats it as a normal dynamic import.
 *
 * Used directly by Node (validators) and by the Web Worker module. The main
 * thread never imports this file; it goes through `openscadClient.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Instance = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedModulePromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadModule(): Promise<any> {
  if (!cachedModulePromise) {
    cachedModulePromise = import("openscad-wasm/openscad.js");
  }
  return cachedModulePromise;
}

async function createInstance(errorSink: string[]): Promise<Instance> {
  const mod = await loadModule();
  const create = (mod as { createOpenSCAD: (opts?: unknown) => Promise<unknown> }).createOpenSCAD;
  return create({
    print: () => {},
    printErr: (msg: string) => {
      errorSink.push(msg);
    },
  });
}

/**
 * Render OpenSCAD source to an indexed Mesh. Throws on render failure.
 *
 * A fresh WASM instance is created per render. OpenSCAD's emscripten runtime
 * does not reliably survive a second `callMain` invocation — the cached
 * instance worked for the first call, then aborted with empty stderr on the
 * second. Spinning up a new instance per call costs ~150 ms (WASM compilation
 * is module-cached) but eliminates the state corruption.
 *
 * Forces the Manifold backend (`--backend=Manifold`): the OpenSCAD WASM build
 * supports both CGAL (default, accurate, very slow) and Manifold (newer, GPU-
 * style fast CSG). Manifold gives us a 10-50× speedup on HSW geometry and the
 * same watertight output, so it's the only sane choice. We bypass the
 * package's `renderToStl` helper because it hardcodes `callMain` without
 * extra flags.
 */
export async function renderScad(code: string): Promise<Mesh> {
  const errors: string[] = [];
  const instance = await createInstance(errors);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (instance as any).getInstance();
  let stl: string;
  try {
    raw.FS.writeFile("/input.scad", code);
    raw.callMain(["/input.scad", "-o", "/output.stl", "--backend=Manifold"]);
    stl = raw.FS.readFile("/output.stl", { encoding: "utf8" });
    try { raw.FS.unlink("/input.scad"); } catch { /* ignore */ }
    try { raw.FS.unlink("/output.stl"); } catch { /* ignore */ }
  } catch (err) {
    const detail = errors.join("\n").trim();
    throw new Error(
      detail
        ? `OpenSCAD render failed: ${detail}`
        : `OpenSCAD render failed (no stderr): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof stl !== "string" || stl.length === 0) {
    const detail = errors.join("\n").trim();
    throw new Error(
      detail
        ? `OpenSCAD returned empty STL: ${detail}`
        : "OpenSCAD returned empty STL — check the source for syntax errors",
    );
  }
  return parseStl(stl);
}
