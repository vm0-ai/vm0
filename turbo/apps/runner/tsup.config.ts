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
  // Bundle @vm0/core since it's a private workspace package not published to npm
  noExternal: ["@vm0/core"],
  // Inject version from package.json at build time
  define: {
    __RUNNER_VERSION__: JSON.stringify(pkg.version),
  },
});
