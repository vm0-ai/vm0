import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopProduct } from "@okouai/api-contracts/contracts/client-headers";
import type { DesktopUpdateLine } from "@okouai/api-contracts/contracts/desktop-updates";
import { readDesktopEnvironment } from "../scripts/desktop-environment.js";
import desktopIdentities from "./desktop-identities.json";
import { rewriteDesktopServiceHostname } from "./desktop-api-base-url";

const DESKTOP_RUNTIME_CONFIG_FILE = "desktop-runtime-config.json";

export type DesktopEnvironment = "production" | "staging" | "development";
type DesktopIdentityKind = "production" | "development";

export interface DesktopIdentity {
  readonly product: DesktopProduct;
  readonly brandName: "Zero" | "Okou";
  readonly displayName: string;
  readonly userDataDirectoryName: string;
  readonly updateLine: DesktopUpdateLine;
  readonly bundleId: string;
  readonly authProtocolName: string;
  readonly authScheme: string;
}

interface DesktopRuntimeConfig {
  readonly platformUrl: string;
  readonly product?: DesktopProduct;
}

export interface DesktopConfig {
  readonly platformUrl: URL;
  readonly webUrl: URL;
  readonly environment: DesktopEnvironment;
  readonly identity: DesktopIdentity;
  readonly sessionPartition: string;
  readonly allowedAppOrigins: ReadonlySet<string>;
}

function desktopProduct(value: string): DesktopProduct {
  if (value === "zero" || value === "okou") {
    return value;
  }
  throw new Error(`Unsupported desktop product: ${value}`);
}

function desktopBrandName(value: string): "Zero" | "Okou" {
  if (value === "Zero" || value === "Okou") {
    return value;
  }
  throw new Error(`Unsupported desktop brand: ${value}`);
}

function desktopUpdateLine(value: string): DesktopUpdateLine {
  if (value === "zero" || value === "okou" || value === "ai-okou-desktop") {
    return value;
  }
  throw new Error(`Unsupported desktop update line: ${value}`);
}

function desktopIdentity(
  product: DesktopProduct,
  kind: DesktopIdentityKind,
): DesktopIdentity {
  const identity = desktopIdentities[product][kind];
  return {
    ...identity,
    product: desktopProduct(identity.product),
    brandName: desktopBrandName(identity.brandName),
    updateLine: desktopUpdateLine(identity.updateLine),
  };
}

function desktopRuntimeConfigPath(): string {
  return join(__dirname, "..", DESKTOP_RUNTIME_CONFIG_FILE);
}

function parseRuntimeConfig(value: unknown): DesktopRuntimeConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    !("platformUrl" in value)
  ) {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} must contain a platformUrl string`,
    );
  }

  const config = value as {
    readonly platformUrl?: unknown;
    readonly product?: unknown;
  };
  if (typeof config.platformUrl !== "string") {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} must contain a platformUrl string`,
    );
  }
  if (config.product !== undefined && typeof config.product !== "string") {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} product must be zero or okou`,
    );
  }

  return {
    platformUrl: config.platformUrl,
    ...(config.product === undefined
      ? {}
      : { product: desktopProduct(config.product) }),
  };
}

function readDesktopRuntimeConfig(): DesktopRuntimeConfig | undefined {
  const configPath = desktopRuntimeConfigPath();
  if (!existsSync(configPath)) {
    return undefined;
  }

  const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  return parseRuntimeConfig(configValue);
}

function configuredProduct(
  rawProduct: string | undefined,
  fileConfig: DesktopRuntimeConfig | undefined,
): DesktopProduct {
  return desktopProduct(
    rawProduct?.trim() ||
      readDesktopEnvironment("OKOU_DESKTOP_PRODUCT") ||
      fileConfig?.product ||
      "okou",
  );
}

function configuredPlatformUrl(
  rawPlatformUrl: string | undefined,
  fileConfig: DesktopRuntimeConfig | undefined,
): string | undefined {
  if (rawPlatformUrl !== undefined) {
    return rawPlatformUrl;
  }
  return (
    readDesktopEnvironment("OKOU_DESKTOP_PLATFORM_URL") ||
    fileConfig?.platformUrl
  );
}

function parsePlatformUrl(
  rawUrl: string | undefined,
  product: DesktopProduct,
): URL {
  const value = rawUrl?.trim() || desktopIdentities[product].defaultPlatformUrl;
  const url = new URL(value);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `OKOU_DESKTOP_PLATFORM_URL must use http or https, received ${url.protocol}`,
    );
  }

  return url;
}

function environmentForPlatformUrl(
  platformUrl: URL,
  hasExplicitUrl: boolean,
): DesktopEnvironment {
  if (
    !hasExplicitUrl ||
    platformUrl.hostname === "app.vm0.ai" ||
    platformUrl.hostname === "app.okou.ai"
  ) {
    return "production";
  }
  if (platformUrl.hostname === "staging-app.omby.ai") {
    return "staging";
  }
  return "development";
}

function identityForEnvironment(
  product: DesktopProduct,
  environment: DesktopEnvironment,
): DesktopIdentity {
  return desktopIdentity(
    product,
    environment === "production" ? "production" : "development",
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function addDerivedOrigin(
  origins: Set<string>,
  platformUrl: URL,
  target: "api" | "www",
): void {
  origins.add(deriveCompanionUrl(platformUrl, target).origin);
}

function allowedOriginsForPlatformUrl(platformUrl: URL): ReadonlySet<string> {
  const origins = new Set<string>([platformUrl.origin]);
  addDerivedOrigin(origins, platformUrl, "www");
  addDerivedOrigin(origins, platformUrl, "api");
  return origins;
}

function deriveCompanionUrl(platformUrl: URL, target: "api" | "www"): URL {
  const url = new URL(platformUrl.toString());
  if (isLocalHost(url.hostname)) {
    if (url.port === "3002") {
      url.port = target === "www" ? "3000" : "3001";
    }
  } else {
    url.hostname = rewriteDesktopServiceHostname(url.hostname, target);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveDesktopConfig(
  rawPlatformUrl?: string,
  rawProduct?: string,
): DesktopConfig {
  const fileConfig = readDesktopRuntimeConfig();
  const product = configuredProduct(rawProduct, fileConfig);
  const platformUrlSource = configuredPlatformUrl(rawPlatformUrl, fileConfig);
  const hasExplicitUrl = Boolean(platformUrlSource?.trim());
  const platformUrl = parsePlatformUrl(platformUrlSource, product);
  const environment = environmentForPlatformUrl(platformUrl, hasExplicitUrl);

  return {
    platformUrl,
    webUrl: deriveCompanionUrl(platformUrl, "www"),
    environment,
    identity: identityForEnvironment(product, environment),
    sessionPartition: `persist:vm0-desktop-${environment}`,
    allowedAppOrigins: allowedOriginsForPlatformUrl(platformUrl),
  };
}
