"use client";

import { useSyncExternalStore } from "react";
import type { AgentUiConfig } from "./config";

/**
 * Client-side store for the agent's NON-SECRET configuration (provider, model,
 * base URL). Persisted in localStorage; the API key never passes through here
 * (see `keystore.ts`). Exposes a `useAgentConfig()` hook so the settings form
 * and the chat panel stay in sync without prop-drilling.
 */

const STORAGE_KEY = "hexweave.agent.config";

const listeners = new Set<() => void>();
let cache: AgentUiConfig | null | undefined; // undefined = not yet read from storage

function read(): AgentUiConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentUiConfig;
    if (!parsed || (parsed.provider !== "anthropic" && parsed.provider !== "openai_compatible")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function emit() {
  for (const l of listeners) l();
}

export function getConfig(): AgentUiConfig | null {
  if (cache === undefined) cache = read();
  return cache;
}

export function setConfig(cfg: AgentUiConfig): void {
  cache = cfg;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }
  emit();
}

export function clearConfig(): void {
  cache = null;
  if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  emit();
}

let storageBound = false;
function ensureStorageBound(): void {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  // Cross-tab sync: one global listener, never removed (harmless singleton).
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cache = read();
      emit();
    }
  });
}

function subscribe(listener: () => void): () => void {
  ensureStorageBound();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: current config (null when unconfigured), re-renders on change. */
export function useAgentConfig(): AgentUiConfig | null {
  return useSyncExternalStore(subscribe, getConfig, () => null);
}
