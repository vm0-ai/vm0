import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    content: "src/content.ts",
    handoff: "src/handoff.ts",
    offscreen: "src/offscreen.ts",
    "service-worker": "src/service-worker.ts",
  },
  format: ["iife"],
  minify: false,
  outExtension: () => {
    return { js: ".js" };
  },
  outDir: "dist",
  platform: "browser",
  sourcemap: true,
  splitting: false,
  target: "chrome116",
});
