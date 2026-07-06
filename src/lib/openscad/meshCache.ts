import type { Mesh } from "@/types";

/**
 * Simple in-memory mesh cache keyed on SCAD source. The SCAD code is
 * deterministic for fixed parameters (numbers serialised at 6 decimals), so
 * identical inputs produce identical strings and hit the cache.
 *
 * Bounded LRU: holds at most `MAX` entries; eviction on the oldest insert.
 * Mesh sizes are typically 50-200 KB, so 200 entries cap memory at ~40 MB —
 * fine for a session.
 */

const MAX = 200;

interface Entry {
  mesh: Mesh;
  /** Insertion order tracker; rewritten on hit so LRU eviction is correct. */
  tick: number;
}

const cache = new Map<string, Entry>();
let counter = 0;

export function cacheGet(key: string): Mesh | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  e.tick = ++counter;
  return e.mesh;
}

export function cacheSet(key: string, mesh: Mesh): void {
  if (cache.has(key)) {
    const e = cache.get(key)!;
    e.mesh = mesh;
    e.tick = ++counter;
    return;
  }
  if (cache.size >= MAX) {
    let oldestKey: string | null = null;
    let oldestTick = Infinity;
    for (const [k, v] of cache) {
      if (v.tick < oldestTick) {
        oldestTick = v.tick;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) cache.delete(oldestKey);
  }
  cache.set(key, { mesh, tick: ++counter });
}

export function cacheStats(): { size: number; hits: number; misses: number } {
  return { size: cache.size, hits: hits, misses: misses };
}

// Lightweight counters for "X% cache hit" telemetry. Reset between sessions.
let hits = 0;
let misses = 0;
export function cacheHit(): void {
  hits++;
}
export function cacheMiss(): void {
  misses++;
}
