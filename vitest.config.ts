import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/**/*.test.ts"],
    // Every test in this suite is an integration test: OpenSCAD-WASM runs,
    // meshes are generated, sometimes original STLs are read from disk. Give
    // them room. Individual tests can override with a per-`it` timeout.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Sequential — OpenSCAD-WASM initialisation is singletons under the hood
    // and parallel runs churn on WASM module setup / memory. Slower to run in
    // parallel than sequentially.
    fileParallelism: false,
    // Keep console.* output from meshing / measurement code visible, useful
    // when a test fails and you want to see the numbers.
    silent: false,
  },
});
