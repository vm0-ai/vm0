import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Inject version from package.json at build time
  define: {
    __RUNNER_VERSION__: JSON.stringify(pkg.version),
  },
});
