const path = require("node:path");

const desktopDomains = require("../src/desktop-domains.json");
const desktopIdentities = require("../src/desktop-identities.json");

const PRODUCTION_PLATFORM_HOSTNAMES = new Set(
  desktopDomains.compatiblePlatformUrls.map((url) => new URL(url).hostname),
);
const DEFAULT_PLATFORM_HOSTNAME = new URL(desktopDomains.defaultPlatformUrl)
  .hostname;

function platformHostname(rawUrl) {
  if (!rawUrl || !rawUrl.trim()) {
    return DEFAULT_PLATFORM_HOSTNAME;
  }
  return new URL(rawUrl).hostname;
}

function desktopIdentityForPlatformUrl(rawUrl) {
  if (PRODUCTION_PLATFORM_HOSTNAMES.has(platformHostname(rawUrl))) {
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
    mcpBundlePath: path.join(
      appBundlePath,
      "Contents",
      "Resources",
      "mcp",
      "index.mjs",
    ),
  };
}

module.exports = { packagedAppPaths };
