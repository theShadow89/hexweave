/**
 * Types for the Electron preload bridge exposed on `window.hexweave`. Present
 * only in the desktop app; `undefined` on web. Keep in sync with
 * `electron/preload.js`.
 */

interface HexweaveKeystoreBridge {
  /** Whether OS-backed encryption (safeStorage) is available on this machine. */
  available(): Promise<boolean>;
  /** Encrypt and persist the API key (OS keychain). */
  set(key: string): Promise<void>;
  /** Decrypt and return the API key, or null if none/undecryptable. */
  get(): Promise<string | null>;
  /** Whether a key is persisted. */
  has(): Promise<boolean>;
  /** Forget the persisted key. */
  clear(): Promise<void>;
}

interface HexweaveBridge {
  platform: string;
  keystore: HexweaveKeystoreBridge;
}

interface Window {
  hexweave?: HexweaveBridge;
}
