const { defineConfig } = require("tsup");

module.exports = defineConfig({
  entry: ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist/mcp",
  sourcemap: true,
  clean: false,
  outExtension() {
    return { js: ".mjs" };
  },
});
