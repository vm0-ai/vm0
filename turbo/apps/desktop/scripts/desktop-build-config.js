const fs = require("node:fs");
const path = require("node:path");

const desktopIdentities = require("../src/desktop-identities.json");
const { readDesktopEnvironment } = require("./desktop-environment");

const PRODUCTION_PLATFORM_HOSTNAMES = new Set(["app.vm0.ai", "app.okou.ai"]);
const RUNTIME_CONFIG_PATH = path.resolve(
  __dirname,
  "..",
  "desktop-runtime-config.json",
);

function desktopProduct(value) {
  if (value === "zero" || value === "okou") {
    return value;
  }
  throw new Error(`Unsupported desktop product: ${value}`);
}

function readRuntimeConfig() {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
    return undefined;
  }
  const value = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
  if (typeof value !== "object" || value === null) {
    throw new Error("desktop-runtime-config.json must contain an object");
  }
  return value;
}

function resolveDesktopBuildConfig(options = {}) {
  const fileConfig = readRuntimeConfig();
  const product = desktopProduct(
    options.product?.trim() ||
      readDesktopEnvironment("OKOU_DESKTOP_PRODUCT") ||
      fileConfig?.product ||
      "okou",
  );
  const platformUrl = new URL(
    options.platformUrl?.trim() ||
      readDesktopEnvironment("OKOU_DESKTOP_PLATFORM_URL") ||
      fileConfig?.platformUrl ||
      desktopIdentities[product].defaultPlatformUrl,
  );
  const identityKind = PRODUCTION_PLATFORM_HOSTNAMES.has(platformUrl.hostname)
    ? "production"
    : "development";

  return {
    identity: desktopIdentities[product][identityKind],
    platformUrl,
    product,
  };
}

module.exports = { resolveDesktopBuildConfig };
