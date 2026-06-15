const { defineConfig } = require("tsup");

module.exports = defineConfig({
  entry: ["src/main.ts", "src/preload.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  external: ["electron"],
  noExternal: ["update-electron-app"],
});
