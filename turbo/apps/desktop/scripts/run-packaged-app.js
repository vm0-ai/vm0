const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const { packagedAppPaths } = require("./packaged-app-paths");

if (process.platform !== "darwin") {
  throw new Error("Packaged desktop dev runs are only supported on macOS.");
}

const { executablePath } = packagedAppPaths(
  process.env.VM0_DESKTOP_PLATFORM_URL,
);

if (!fs.existsSync(executablePath)) {
  throw new Error(`Packaged app executable was not found at ${executablePath}`);
}

const child = spawnSync(executablePath, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});

if (child.error) {
  throw child.error;
}

process.exit(child.status ?? 1);
