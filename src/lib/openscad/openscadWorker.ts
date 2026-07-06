/// <reference lib="webworker" />

import { renderScad } from "./openscadInit";

export interface RenderRequest {
  id: number;
  code: string;
}

export interface RenderResponse {
  id: number;
  ok: true;
  positions: ArrayBuffer;
  indices: ArrayBuffer;
}

export interface RenderError {
  id: number;
  ok: false;
  error: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener("message", async (event: MessageEvent<RenderRequest>) => {
  const { id, code } = event.data;
  try {
    const mesh = await renderScad(code);
    const positions = new ArrayBuffer(mesh.positions.byteLength);
    new Uint8Array(positions).set(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
    const indices = new ArrayBuffer(mesh.indices.byteLength);
    new Uint8Array(indices).set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
    const reply: RenderResponse = { id, ok: true, positions, indices };
    ctx.postMessage(reply, [positions, indices]);
  } catch (err) {
    const reply: RenderError = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(reply);
  }
});
