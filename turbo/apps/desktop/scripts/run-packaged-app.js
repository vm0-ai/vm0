const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopIdentities = require("../src/desktop-identities.json");

const PRODUCTION_PLATFORM_HOSTNAME = "app.vm0.ai";

function platformHostname(rawUrl) {
  if (!rawUrl || !rawUrl.trim()) {
    return PRODUCTION_PLATFORM_HOSTNAME;
  }
  return new URL(rawUrl).hostname;
}

function desktopIdentityForPlatformUrl(rawUrl) {
  if (platformHostname(rawUrl) === PRODUCTION_PLATFORM_HOSTNAME) {
    return desktopIdentities.production;
  }
  return desktopIdentities.development;
}

if (process.platform !== "darwin") {
  throw new Error("Packaged desktop dev runs are only supported on macOS.");
}

const appRoot = path.resolve(__dirname, "..");
const desktopIdentity = desktopIdentityForPlatformUrl(
  process.env.VM0_DESKTOP_PLATFORM_URL,
);
const appName = desktopIdentity.displayName;
const appBundlePath = path.join(
  appRoot,
  "out",
  `${appName}-${process.platform}-${process.arch}`,
  `${appName}.app`,
);
const executablePath = path.join(appBundlePath, "Contents", "MacOS", appName);

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
