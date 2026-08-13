// Minimal, contextIsolation-safe bridge. Exposes only what the renderer needs:
// the platform string and a keystore for the BYOK agent key. No raw Node access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hexweave", {
  platform: process.platform,
  keystore: {
    available: () => ipcRenderer.invoke("keystore:available"),
    set: (key) => ipcRenderer.invoke("keystore:set", key),
    get: () => ipcRenderer.invoke("keystore:get"),
    has: () => ipcRenderer.invoke("keystore:has"),
    clear: () => ipcRenderer.invoke("keystore:clear"),
  },
});
