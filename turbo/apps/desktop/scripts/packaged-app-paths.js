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

function packagedAppPaths(platformUrl) {
  const appRoot = path.resolve(__dirname, "..");
  const appName = desktopIdentityForPlatformUrl(platformUrl).displayName;
  const appBundlePath = path.join(
    appRoot,
    "out",
    `${appName}-${process.platform}-${process.arch}`,
    `${appName}.app`,
  );

  return {
    appBundlePath,
    executablePath: path.join(appBundlePath, "Contents", "MacOS", appName),
    mainBundlePath: path.join(
      appBundlePath,
      "Contents",
      "Resources",
      "app",
      "dist",
      "main.js",
    ),
  };
}

module.exports = { packagedAppPaths };
