import { defineConfig } from "tsup";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as {
  version: string;
};

const isWatchMode = process.argv.includes("--watch");

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Skip DTS generation in watch mode to avoid memory issues
  // DTS files are still generated during production builds
  dts: !isWatchMode,
  sourcemap: true,
  clean: true,
  shims: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Bundle workspace packages
  noExternal: [/@vm0\/.*/],
  // Inject version and default Sentry DSN from package.json/env at build time
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    __DEFAULT_SENTRY_DSN__: JSON.stringify(
      process.env.DEFAULT_SENTRY_DSN ?? "",
    ),
  },
  onSuccess: isWatchMode
    ? async () => {
        console.log("Installing vm0 CLI globally...");
        execSync("sudo npm link --local", { cwd: "dist", stdio: "inherit" });
        console.log("vm0 CLI installed globally");
      }
    : undefined,
});
