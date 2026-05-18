const PRODUCTION_PLATFORM_URL = "https://app.vm0.ai";

type DesktopEnvironment = "production" | "staging" | "development";

interface DesktopConfig {
  readonly platformUrl: URL;
  readonly environment: DesktopEnvironment;
  readonly sessionPartition: string;
  readonly allowedAppOrigins: ReadonlySet<string>;
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

function addDerivedOrigin(
  origins: Set<string>,
  platformUrl: URL,
  target: "api" | "www",
): void {
  if (
    platformUrl.hostname === "localhost" ||
    platformUrl.hostname === "127.0.0.1"
  ) {
    return;
  }

  const url = new URL(platformUrl.toString());
  url.hostname = url.hostname.replace(
    /(^|-)(api|app|platform|www)\./,
    `$1${target}.`,
  );
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  origins.add(url.origin);
}

function allowedOriginsForPlatformUrl(platformUrl: URL): ReadonlySet<string> {
  const origins = new Set<string>([platformUrl.origin]);
  addDerivedOrigin(origins, platformUrl, "www");
  addDerivedOrigin(origins, platformUrl, "api");
  return origins;
}

export function resolveDesktopConfig(
  rawPlatformUrl = process.env.VM0_DESKTOP_PLATFORM_URL,
): DesktopConfig {
  const hasExplicitUrl = Boolean(rawPlatformUrl?.trim());
  const platformUrl = parsePlatformUrl(rawPlatformUrl);
  const environment = environmentForPlatformUrl(platformUrl, hasExplicitUrl);

  return {
    platformUrl,
    environment,
    sessionPartition: `persist:vm0-desktop-${environment}`,
    allowedAppOrigins: allowedOriginsForPlatformUrl(platformUrl),
  };
}
