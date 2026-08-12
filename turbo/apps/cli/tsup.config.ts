import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as {
  version: string;
};

const isWatchMode = process.argv.includes("--watch");
const piSqliteBackendEntryPath = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-session-backend-sqlite-node"),
);
const piSqliteMigrationSourcePath = resolve(
  dirname(piSqliteBackendEntryPath),
  "sqlite/migrations/001_initial.sql",
);

function copyPiSqliteMigration(): void {
  const migrationDirectory = resolve("dist/migrations");
  mkdirSync(migrationDirectory, { recursive: true });
  copyFileSync(
    piSqliteMigrationSourcePath,
    resolve(migrationDirectory, "001_initial.sql"),
  );
}

export default defineConfig({
  entry: ["src/okou.ts"],
  format: ["esm"],
  // Skip DTS generation in watch mode to avoid memory issues
  // DTS files are still generated during production builds
  dts: !isWatchMode,
  sourcemap: true,
  clean: true,
  shims: true,
  removeNodeProtocol: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Provide CJS require() for bundled CommonJS packages that call
      // require("events"), require("fs"), etc. at runtime.
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // Resolve packages from the CLI's node_modules when bundling workspace deps
  // (e.g. @vm0/core imports zod, which lives in apps/cli/node_modules)
  esbuildOptions(options) {
    options.nodePaths = [resolve("node_modules")];
  },
  // Inject version and default Sentry DSN from package.json/env at build time
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    __DEFAULT_SENTRY_DSN__: JSON.stringify(
      process.env.DEFAULT_SENTRY_DSN ?? "",
    ),
  },
  onSuccess: async () => {
    copyPiSqliteMigration();
    if (!isWatchMode) {
      return;
    }
    console.log("Uploading Okou CLI for local runners...");
    execSync("pnpm --workspace-root deploy-cli:local", {
      stdio: "inherit",
    });
    console.log("Okou CLI uploaded for local runners");
    console.log("Installing Okou CLI globally...");
    execSync("sudo npm link --local", { cwd: "dist", stdio: "inherit" });
    console.log("Okou CLI installed globally");
  },
});
