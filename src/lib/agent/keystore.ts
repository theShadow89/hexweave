"use client";

/**
 * Local, secure storage for the BYOK API key. The key never reaches an Intella
 * server: it is persisted on the client and read into memory only to make the
 * direct provider call (see `runAgent.ts`).
 *
 * Two backends, chosen at runtime:
 *  - OsKeyStore (desktop): delegates to Electron `safeStorage` via the
 *    `window.hexweave.keystore` IPC bridge (OS keychain / DPAPI / libsecret).
 *    No passphrase needed.
 *  - PassphraseKeyStore (web, and desktop fallback when the OS keyring is
 *    unavailable): encrypts the key with AES-GCM under a key derived from a
 *    user passphrase (PBKDF2-SHA-256, 600k iterations). The passphrase is never
 *    stored, so the ciphertext at rest is useless without it; it must be
 *    re-entered each session to unlock.
 */

export type KeyStoreKind = "os" | "passphrase";

export interface KeyStore {
  readonly kind: KeyStoreKind;
  /** True if a key is persisted (regardless of unlock state). */
  hasKey(): Promise<boolean>;
  /** True if the plaintext key is available in memory right now. */
  isUnlocked(): boolean;
  /** Load the key into memory. OS backend ignores the passphrase. */
  unlock(passphrase?: string): Promise<boolean>;
  /** In-memory plaintext key, or null when locked. */
  getKey(): string | null;
  /** Persist (encrypt) a new key and unlock it in memory. */
  setKey(apiKey: string, passphrase?: string): Promise<void>;
  /** Forget the persisted key and drop it from memory. */
  clear(): Promise<void>;
}

// --- change notifications (so settings + chat panel stay in sync) -----------

const listeners = new Set<() => void>();
export function subscribeKeyStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function emit() {
  for (const l of listeners) l();
}

// --- base64 + Web Crypto helpers --------------------------------------------

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/** UTF-8 encode, guaranteed ArrayBuffer-backed (satisfies BufferSource). */
function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(s));
}

async function deriveAesKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", utf8(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// --- OS backend (Electron safeStorage via IPC) ------------------------------

type Bridge = NonNullable<Window["hexweave"]>["keystore"];

class OsKeyStore implements KeyStore {
  readonly kind = "os" as const;
  private memKey: string | null = null;
  constructor(private bridge: Bridge) {}

  hasKey(): Promise<boolean> {
    return this.bridge.has();
  }
  isUnlocked(): boolean {
    return this.memKey !== null;
  }
  async unlock(): Promise<boolean> {
    this.memKey = await this.bridge.get();
    emit();
    return this.memKey !== null;
  }
  getKey(): string | null {
    return this.memKey;
  }
  async setKey(apiKey: string): Promise<void> {
    await this.bridge.set(apiKey);
    this.memKey = apiKey;
    emit();
  }
  async clear(): Promise<void> {
    await this.bridge.clear();
    this.memKey = null;
    emit();
  }
}

// --- Web backend (passphrase-encrypted, localStorage at rest) ---------------

const BLOB_KEY = "hexweave.agent.keyblob";

interface KeyBlob {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

class PassphraseKeyStore implements KeyStore {
  readonly kind = "passphrase" as const;
  private memKey: string | null = null;

  private readBlob(): KeyBlob | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(BLOB_KEY);
      return raw ? (JSON.parse(raw) as KeyBlob) : null;
    } catch {
      return null;
    }
  }

  async hasKey(): Promise<boolean> {
    return this.readBlob() !== null;
  }
  isUnlocked(): boolean {
    return this.memKey !== null;
  }
  getKey(): string | null {
    return this.memKey;
  }

  async unlock(passphrase?: string): Promise<boolean> {
    const blob = this.readBlob();
    if (!blob || !passphrase) return false;
    try {
      const key = await deriveAesKey(passphrase, fromB64(blob.salt));
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(blob.iv) },
        key,
        fromB64(blob.ct),
      );
      this.memKey = new TextDecoder().decode(plain);
      emit();
      return true;
    } catch {
      return false; // wrong passphrase or tampered blob
    }
  }

  async setKey(apiKey: string, passphrase?: string): Promise<void> {
    if (!passphrase) throw new Error("A passphrase is required to store the key on web.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(apiKey));
    const blob: KeyBlob = { v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
    window.localStorage.setItem(BLOB_KEY, JSON.stringify(blob));
    this.memKey = apiKey;
    emit();
  }

  async clear(): Promise<void> {
    if (typeof window !== "undefined") window.localStorage.removeItem(BLOB_KEY);
    this.memKey = null;
    emit();
  }
}

// --- backend selection (resolved once) --------------------------------------

let resolved: KeyStore | null = null;
let resolving: Promise<KeyStore> | null = null;

/**
 * Resolve the active keystore. OS-backed when the Electron bridge is present
 * AND the OS keyring is available; otherwise passphrase-backed (web, or desktop
 * on a headless Linux with no keyring).
 */
export function getKeyStore(): Promise<KeyStore> {
  if (resolved) return Promise.resolve(resolved);
  if (resolving) return resolving;
  resolving = (async () => {
    const bridge = typeof window !== "undefined" ? window.hexweave?.keystore : undefined;
    let available = false;
    if (bridge) {
      try {
        available = await bridge.available();
      } catch {
        available = false;
      }
    }
    const store: KeyStore = bridge && available ? new OsKeyStore(bridge) : new PassphraseKeyStore();
    // Desktop: the OS keychain needs no passphrase, so unlock eagerly.
    if (store.kind === "os" && (await store.hasKey())) {
      await store.unlock();
    }
    resolved = store;
    return resolved;
  })();
  return resolving;
}
