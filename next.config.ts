import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle at .next/standalone so the Docker
  // runner stage can ship a minimal image (server.js + traced node_modules
  // subset) instead of copying the full dependency tree.
  output: "standalone",
  // Add hostnames/IPs here if you need to access the dev server from another
  // machine on the LAN (Next 16 blocks cross-origin dev requests by default).
  // Example: allowedDevOrigins: ["192.168.1.100"],
};

export default nextConfig;
