import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle at .next/standalone so the Docker
  // runner stage — and the Electron desktop shell — can ship a minimal server
  // (server.js + traced node_modules subset) instead of the full dep tree.
  output: "standalone",
  // Pin the file-tracing root to this project. Without it, a package.json /
  // lockfile in a parent directory (e.g. the user's home) makes Next infer a
  // higher root and nest the standalone output under the project path, which
  // breaks deterministic packaging. Pinning yields a flat .next/standalone/server.js.
  outputFileTracingRoot: path.join(__dirname),
  // The app uses no next/image, so the default optimizer (sharp) is never used
  // at runtime. Disable it and drop sharp from the file trace: that keeps the
  // standalone node_modules pure JS/WASM (~30-40 MB smaller, no wrong-platform
  // native binary shipped by mistake).
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    "*": ["node_modules/sharp/**", "node_modules/@img/**"],
  },
  // Add hostnames/IPs here if you need to access the dev server from another
  // machine on the LAN (Next 16 blocks cross-origin dev requests by default).
  // Example: allowedDevOrigins: ["192.168.1.100"],
};

export default nextConfig;
