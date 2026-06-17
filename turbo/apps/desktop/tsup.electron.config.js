const { defineConfig } = require("tsup");
const { readFileSync } = require("node:fs");

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

module.exports = defineConfig({
  entry: ["src/main.ts", "src/preload.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  external: ["electron"],
  noExternal: ["update-electron-app", "@sentry/electron"],
  define: {
    __DESKTOP_VERSION__: JSON.stringify(pkg.version),
    __DESKTOP_SENTRY_DSN__: JSON.stringify(
      process.env.SENTRY_DSN_DESKTOP ?? "",
    ),
    __DESKTOP_SENTRY_ENVIRONMENT__: JSON.stringify(
      process.env.SENTRY_ENVIRONMENT ?? "development",
    ),
  },
});
