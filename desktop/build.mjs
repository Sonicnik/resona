// Bundles the backend and the Electron main/preload into build/, so the app runs without tsx or node_modules.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node22", logLevel: "info" };

await Promise.all([
  build({
    ...common,
    entryPoints: ["../backend/src/index.ts"],
    outfile: "build/backend.mjs",
    format: "esm",
    // Express and other CJS deps call require(); ESM output needs a real one.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }),
  build({ ...common, entryPoints: ["src/main.ts"], outfile: "build/main.mjs", format: "esm", external: ["electron"] }),
  // Sandboxed preloads must be CommonJS.
  build({ ...common, entryPoints: ["src/preload.ts"], outfile: "build/preload.cjs", format: "cjs", external: ["electron"] }),
]);
