const path = require("node:path");

const desktopIdentities = require("./src/desktop-identities.json");

const PRODUCTION_PLATFORM_HOSTNAME = "app.vm0.ai";
const DEVELOPER_ID_APPLICATION_IDENTITY =
  "Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)";
const codeSigningIdentity =
  process.env.CI === "true" ? "-" : DEVELOPER_ID_APPLICATION_IDENTITY;

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

const desktopIdentity = desktopIdentityForPlatformUrl(
  process.env.VM0_DESKTOP_PLATFORM_URL,
);

module.exports = {
  packagerConfig: {
    name: desktopIdentity.displayName,
    executableName: desktopIdentity.displayName,
    appBundleId: desktopIdentity.bundleId,
    icon: path.join(__dirname, "assets", "icon"),
    extendInfo: {
      CFBundleIconFile: "icon.icns",
    },
    asar: false,
    extraResource: [path.join(__dirname, "native", "dist", "native")],
    osxSign: {
      identity: codeSigningIdentity,
      identityValidation: codeSigningIdentity !== "-",
    },
    protocols: [
      {
        name: desktopIdentity.authProtocolName,
        schemes: [desktopIdentity.authScheme],
      },
    ],
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/native($|\/)/,
      /^\/scripts($|\/)/,
      /^\/\.turbo($|\/)/,
      /^\/\.npmrc$/,
      /^\/README\.md$/,
      /^\/forge\.config\.js$/,
      /^\/tsconfig\.json$/,
      /^\/vite\.renderer\.config\.ts$/,
      /^\/vitest\.config\.ts$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
