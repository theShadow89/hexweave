// Electron main process for Hexweave desktop.
//
// Production: spawn the Next.js standalone server (server.js) as an isolated
// child bound to a random loopback port, wait until it answers, then load it.
// The child runs on the Electron binary itself (ELECTRON_RUN_AS_NODE) so we
// ship no separate Node. Dev: load the running `next dev` on :3000.
//
// Also exposes a safeStorage-backed keystore over IPC for the BYOK agent key
// (OS keychain / DPAPI / libsecret). The key never reaches an Intella server.

const { app, BrowserWindow, shell, dialog, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

let serverProc = null;
let win = null;

/** Grab a free TCP port on the loopback interface. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Resolve once the given loopback port answers any HTTP response. */
function waitForHttp(port, host = "127.0.0.1", timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host, port, path: "/", timeout: 2000 }, (res) => {
        res.destroy();
        resolve();
      });
      req.on("error", () =>
        Date.now() > deadline
          ? reject(new Error("Next server did not become ready"))
          : setTimeout(tick, 150),
      );
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

/**
 * Spawn the standalone server on a fresh free port. `server.js` uses
 * allowRetry:false and coerces PORT via `parseInt(PORT,10) || 3000`, so we must
 * pass a concrete non-zero port and retry with a new one on an early failure.
 */
async function startNextServer() {
  const dir = path.join(process.resourcesPath, "standalone");
  const serverJs = path.join(dir, "server.js");
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await getFreePort();
    serverProc = spawn(process.execPath, [serverJs], {
      cwd: dir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1", // loopback only, keep off the LAN
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stdout.on("data", (d) => console.log("[next]", `${d}`.trim()));
    serverProc.stderr.on("data", (d) => console.error("[next]", `${d}`.trim()));
    try {
      await waitForHttp(port);
      return port;
    } catch {
      try {
        serverProc.kill();
      } catch {
        /* ignore */
      }
      serverProc = null;
    }
  }
  throw new Error("Could not start the local server on any port");
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0d0d10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  let origin;
  if (app.isPackaged) {
    origin = `http://127.0.0.1:${await startNextServer()}`;
  } else {
    origin = "http://localhost:3000";
    await waitForHttp(3000, "localhost"); // next dev may still be compiling
  }

  // Defense in depth: external links open in the system browser, no in-app nav
  // off the local origin, no popups.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  await win.loadURL(origin);
}

// --- BYOK keystore (safeStorage) --------------------------------------------

const keyFile = () => path.join(app.getPath("userData"), "keystore.bin");

ipcMain.handle("keystore:available", () => safeStorage.isEncryptionAvailable());
ipcMain.handle("keystore:set", (_e, plaintext) => {
  fs.writeFileSync(keyFile(), safeStorage.encryptString(String(plaintext)), { mode: 0o600 });
});
ipcMain.handle("keystore:get", () => {
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return null;
  }
});
ipcMain.handle("keystore:has", () => fs.existsSync(keyFile()));
ipcMain.handle("keystore:clear", () => {
  try {
    fs.unlinkSync(keyFile());
  } catch {
    /* ignore */
  }
});

// --- app lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  createWindow().catch((err) => {
    dialog.showErrorBox("Hexweave failed to start", String(err));
    app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* ignore */
    }
  }
});
