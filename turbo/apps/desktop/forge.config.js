const path = require("node:path");

const packageMetadata = require("./package.json");
const desktopIdentities = require("./src/desktop-identities.json");

const PRODUCTION_PLATFORM_HOSTNAME = "app.vm0.ai";
const DEVELOPER_ID_APPLICATION_IDENTITY =
  "Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)";
const codeSigningIdentity =
  process.env.VM0_DESKTOP_SIGNING_IDENTITY ??
  (process.env.CI === "true" ? "-" : DEVELOPER_ID_APPLICATION_IDENTITY);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function desktopNotarizeOptions() {
  if (process.env.VM0_DESKTOP_NOTARIZE !== "true") {
    return undefined;
  }

  return {
    appleApiKey: requiredEnv("VM0_DESKTOP_NOTARIZE_API_KEY_PATH"),
    appleApiKeyId: requiredEnv("VM0_DESKTOP_NOTARIZE_API_KEY_ID"),
    appleApiIssuer: requiredEnv("VM0_DESKTOP_NOTARIZE_API_ISSUER"),
  };
}

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
const osxNotarize = desktopNotarizeOptions();

// Forge 7 bundles Packager 18, whose CommonJS signing adapter cannot call osx-sign v2.
async function signPackagedDarwinApps(_forgeConfig, packageResult) {
  if (packageResult.platform !== "darwin") {
    return;
  }

  const { sign } = await import("@electron/osx-sign");
  const notarizeModule = osxNotarize
    ? await import("@electron/notarize")
    : undefined;

  for (const outputPath of packageResult.outputPaths) {
    const appPath = path.join(outputPath, `${desktopIdentity.displayName}.app`);

    await sign({
      app: appPath,
      batchCodesignCalls: true,
      identity: codeSigningIdentity,
      identityValidation: codeSigningIdentity !== "-",
      platform: "darwin",
      version: packageMetadata.devDependencies.electron,
      ...(codeSigningIdentity === "-" ? { timestamp: "none" } : {}),
    });

    if (notarizeModule) {
      await notarizeModule.notarize({
        appPath,
        ...osxNotarize,
      });
    }
  }
}

module.exports = {
  hooks: {
    postPackage: signPackagedDarwinApps,
  },
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
