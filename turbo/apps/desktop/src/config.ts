import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import desktopIdentities from "./desktop-identities.json";

const PRODUCTION_PLATFORM_URL = "https://app.vm0.ai";
const DESKTOP_RUNTIME_CONFIG_FILE = "desktop-runtime-config.json";

export type DesktopEnvironment = "production" | "staging" | "development";
type DesktopIdentityKind = "production" | "development";

interface DesktopIdentity {
  readonly displayName: string;
  readonly bundleId: string;
  readonly authProtocolName: string;
  readonly authScheme: string;
}

const DESKTOP_IDENTITIES: Record<DesktopIdentityKind, DesktopIdentity> =
  desktopIdentities;

export interface DesktopConfig {
  readonly platformUrl: URL;
  readonly webUrl: URL;
  readonly environment: DesktopEnvironment;
  readonly identity: DesktopIdentity;
  readonly sessionPartition: string;
  readonly allowedAppOrigins: ReadonlySet<string>;
}

function desktopRuntimeConfigPath(): string {
  return join(__dirname, "..", DESKTOP_RUNTIME_CONFIG_FILE);
}

function runtimeConfigPlatformUrl(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("platformUrl" in value)
  ) {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} must contain a platformUrl string`,
    );
  }

  const config = value as { readonly platformUrl?: unknown };
  if (typeof config.platformUrl !== "string") {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} must contain a platformUrl string`,
    );
  }

  return config.platformUrl;
}

function readDesktopRuntimeConfigPlatformUrl(): string | undefined {
  const configPath = desktopRuntimeConfigPath();
  if (!existsSync(configPath)) {
    return undefined;
  }

  const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  return runtimeConfigPlatformUrl(configValue);
}

function configuredPlatformUrl(
  rawPlatformUrl: string | undefined,
): string | undefined {
  if (rawPlatformUrl !== undefined) {
    return rawPlatformUrl;
  }

  if (process.env.VM0_DESKTOP_PLATFORM_URL?.trim()) {
    return process.env.VM0_DESKTOP_PLATFORM_URL;
  }

  return readDesktopRuntimeConfigPlatformUrl();
}

function parsePlatformUrl(rawUrl: string | undefined): URL {
  const value = rawUrl?.trim() || PRODUCTION_PLATFORM_URL;
  const url = new URL(value);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `VM0_DESKTOP_PLATFORM_URL must use http or https, received ${url.protocol}`,
    );
  }

  return url;
}

function environmentForPlatformUrl(
  platformUrl: URL,
  hasExplicitUrl: boolean,
): DesktopEnvironment {
  if (!hasExplicitUrl || platformUrl.hostname === "app.vm0.ai") {
    return "production";
  }
  if (platformUrl.hostname === "staging-app.vm6.ai") {
    return "staging";
  }
  return "development";
}

function identityForEnvironment(
  environment: DesktopEnvironment,
): DesktopIdentity {
  if (environment === "production") {
    return DESKTOP_IDENTITIES.production;
  }
  return DESKTOP_IDENTITIES.development;
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
    url.hostname = url.hostname.replace(
      /(^|-)(api|app|platform|www)\./,
      `$1${target}.`,
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveDesktopConfig(rawPlatformUrl?: string): DesktopConfig {
  const platformUrlSource = configuredPlatformUrl(rawPlatformUrl);
  const hasExplicitUrl = Boolean(platformUrlSource?.trim());
  const platformUrl = parsePlatformUrl(platformUrlSource);
  const environment = environmentForPlatformUrl(platformUrl, hasExplicitUrl);

  return {
    platformUrl,
    webUrl: deriveCompanionUrl(platformUrl, "www"),
    environment,
    identity: identityForEnvironment(environment),
    sessionPartition: `persist:vm0-desktop-${environment}`,
    allowedAppOrigins: allowedOriginsForPlatformUrl(platformUrl),
  };
}
