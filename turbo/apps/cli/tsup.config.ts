import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Skip DTS generation in watch mode to avoid memory issues
  // DTS files are still generated during production builds
  dts: !process.argv.includes("--watch"),
  sourcemap: true,
  clean: true,
  shims: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Bundle workspace packages
  noExternal: [/@vm0\/.*/],
  // Inject version from package.json at build time
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
