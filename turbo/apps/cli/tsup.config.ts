import { defineConfig } from "tsup";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as {
  version: string;
};

const isWatchMode = process.argv.includes("--watch");

export default defineConfig({
  entry: ["src/index.ts", "src/zero.ts"],
  format: ["esm"],
  // Skip DTS generation in watch mode to avoid memory issues
  // DTS files are still generated during production builds
  dts: !isWatchMode,
  sourcemap: true,
  clean: true,
  shims: true,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Provide a real require() for CJS packages bundled into ESM output.
      // esbuild's __require shim checks typeof require and uses it if available.
      'import { createRequire as __bundled_createRequire } from "module";',
      "var require = __bundled_createRequire(import.meta.url);",
    ].join("\n"),
  },
  // Bundle workspace packages and pure JS dependencies to avoid
  // intermittent "Cannot find module" failures in CI artifact transfer.
  // Keep @sentry/node external (OpenTelemetry runtime hooks) and
  // @ngrok/ngrok external (native NAPI bindings).
  noExternal: [
    /@vm0\/.*/,
    "commander",
    "chalk",
    "prompts",
    "yaml",
    "zod",
    "dotenv",
    "tar",
    "undici",
    "@ts-rest/core",
  ],
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
