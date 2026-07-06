import type { Mesh } from "@/types";
import type { RenderError, RenderRequest, RenderResponse } from "./openscadWorker";
import { cacheGet, cacheHit, cacheMiss, cacheSet } from "./meshCache";

/**
 * Browser-side OpenSCAD client. Lazily spawns a single dedicated worker on the
 * first `runOpenScad` call, then multiplexes render jobs through it serially
 * (the underlying WASM has one shared filesystem so we cannot parallelise
 * renders inside one instance).
 *
 * Node (validators, tests) skips the worker entirely — it dynamically imports
 * `openscadInit` to render in-process. `isBrowser()` keeps the two paths apart.
 */

const isBrowser = typeof window !== "undefined" && typeof Worker !== "undefined";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, {
  resolve: (m: Mesh) => void;
  reject: (e: Error) => void;
}>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./openscadWorker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<RenderResponse | RenderError>) => {
    const data = event.data;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve({
        positions: new Float32Array(data.positions),
        indices: new Uint32Array(data.indices),
      });
    } else {
      entry.reject(new Error(data.error));
    }
  });
  worker.addEventListener("error", (event) => {
    const err = new Error(`OpenSCAD worker error: ${event.message}`);
    for (const [id, entry] of pending) {
      entry.reject(err);
      pending.delete(id);
    }
  });
  return worker;
}

let renderQueue: Promise<unknown> = Promise.resolve();

/**
 * Render OpenSCAD source to an indexed Mesh. Calls are serialised globally
 * (per-process) so the WASM filesystem and stdout/stderr don't interleave.
 * Identical SCAD source hits an in-memory cache (instant return, no worker
 * round-trip) — the typical UX where the user nudges one param re-renders
 * only the things that actually changed.
 */
export function runOpenScad(code: string): Promise<Mesh> {
  const cached = cacheGet(code);
  if (cached) {
    cacheHit();
    return Promise.resolve(cached);
  }
  cacheMiss();
  const job = renderQueue.then(() => doRender(code));
  renderQueue = job.catch(() => undefined);
  return job.then((mesh) => {
    cacheSet(code, mesh);
    return mesh;
  });
}

async function doRender(code: string): Promise<Mesh> {
  if (!isBrowser) {
    const { renderScad } = await import("./openscadInit");
    return renderScad(code);
  }
  return new Promise<Mesh>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const req: RenderRequest = { id, code };
    getWorker().postMessage(req);
  });
}

/** Terminate the worker (HMR cleanup). No-op in Node. */
export function disposeOpenScadWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  pending.clear();
}

/**
 * Pre-warm the worker + WASM module on app mount. Issues a trivial render
 * (a 1 mm cube) so by the time the user clicks Generate, the 13.9 MB JS
 * module is downloaded, parsed, and the openscad-wasm runtime has been
 * initialised at least once. Result is discarded.
 */
let prewarmed = false;
export function prewarmOpenScad(): void {
  if (prewarmed) return;
  prewarmed = true;
  runOpenScad("cube(1);").catch(() => {
    // Re-arm so a real Generate click can still try; first-render error
    // will surface to the user there.
    prewarmed = false;
  });
}
