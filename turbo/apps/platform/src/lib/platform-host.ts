type PlatformEnvironment = "development" | "preview" | "production";

export type PlatformService = "api" | "www" | "app" | "platform";

interface PlatformRuntimeConfig {
  readonly environment: PlatformEnvironment;
  readonly clerkPublishableKey: string;
  readonly publicArtifactsBaseUrl: "https://cdn.vm0.io" | "https://cdn.vm7.io";
  readonly zeroHostDomain: "sites.vm0.io" | "sites.vm7.io";
  readonly plausibleScriptUrl: string | null;
  readonly postHogKey: string | null;
  readonly sentryDsn: string | null;
  readonly vapidPublicKey: string | null;
}

const PRODUCTION_DOMAIN = "vm0.ai";
const OKOU_PRODUCTION_DOMAIN = "okou.ai";
const OKOU_PREVIEW_DOMAIN = "omby.ai";
const PREVIEW_API_DOMAIN = "vm6.ai";
export const PRODUCTION_SATELLITE_HOSTNAME = "app.okou.ai";
const PLATFORM_SERVICE_LABELS = ["platform", "app", "www", "api"] as const;

function browserHostname(): string | null {
  if (typeof location === "undefined" || !location.hostname) {
    return null;
  }
  return location.hostname.toLowerCase();
}

export function isOkouProductionHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === OKOU_PRODUCTION_DOMAIN ||
    normalizedHostname.endsWith(`.${OKOU_PRODUCTION_DOMAIN}`)
  );
}

export function isProductionSatelliteHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === PRODUCTION_SATELLITE_HOSTNAME ||
    normalizedHostname.endsWith(`.${PRODUCTION_SATELLITE_HOSTNAME}`)
  );
}

function isProductionHostname(hostname: string): boolean {
  return (
    hostname === PRODUCTION_DOMAIN ||
    hostname.endsWith(`.${PRODUCTION_DOMAIN}`) ||
    isOkouProductionHostname(hostname)
  );
}

export function rewritePlatformHostname(
  hostname: string,
  target: PlatformService,
): string {
  const labels = hostname.split(".");
  const serviceLabelIndex = labels.length - 3;
  if (serviceLabelIndex < 0) {
    return hostname;
  }

  const serviceLabel = labels[serviceLabelIndex];
  if (!serviceLabel) {
    return hostname;
  }

  if ((PLATFORM_SERVICE_LABELS as readonly string[]).includes(serviceLabel)) {
    labels[serviceLabelIndex] = target;
    return labels.join(".");
  }

  for (const label of PLATFORM_SERVICE_LABELS) {
    const suffix = `-${label}`;
    if (serviceLabel.endsWith(suffix)) {
      labels[serviceLabelIndex] =
        `${serviceLabel.slice(0, -label.length)}${target}`;
      return labels.join(".");
    }
  }

  return hostname;
}

function rewritePreviewServiceHostname(
  hostname: string,
  target: PlatformService,
): string {
  const rewrittenHostname = rewritePlatformHostname(hostname, target);
  const okouPreviewSuffix = `.${OKOU_PREVIEW_DOMAIN}`;
  if (target !== "api" || !rewrittenHostname.endsWith(okouPreviewSuffix)) {
    return rewrittenHostname;
  }
  return `${rewrittenHostname.slice(0, -okouPreviewSuffix.length)}.${PREVIEW_API_DOMAIN}`;
}

export function derivePlatformServiceOrigin(
  currentOrigin: string,
  target: PlatformService,
): string {
  const url = new URL(currentOrigin);

  // Production frontends may be served by more than one provider-specific
  // hostname. They all share the canonical API and web services.
  url.hostname = isProductionHostname(url.hostname)
    ? `${target}.${PRODUCTION_DOMAIN}`
    : rewritePreviewServiceHostname(url.hostname, target);

  return url.origin;
}

export function resolvePlatformEnvironment(): PlatformEnvironment {
  const hostname = browserHostname();
  if (!hostname) {
    return "preview";
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "development";
  }

  return isProductionHostname(hostname) ? "production" : "preview";
}

function optionalBuildValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function requiredBuildValue(value: unknown, name: string): string {
  const normalized = optionalBuildValue(value);
  if (!normalized) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return normalized;
}

export function resolvePlatformRuntimeConfig(): PlatformRuntimeConfig {
  const environment = resolvePlatformEnvironment();

  if (environment === "production") {
    return {
      environment,
      clerkPublishableKey: requiredBuildValue(
        import.meta.env.VITE_CLERK_PUBLISHABLE_KEY_PROD,
        "VITE_CLERK_PUBLISHABLE_KEY_PROD",
      ),
      publicArtifactsBaseUrl: "https://cdn.vm0.io",
      zeroHostDomain: "sites.vm0.io",
      plausibleScriptUrl: optionalBuildValue(
        import.meta.env.VITE_PLAUSIBLE_SCRIPT_URL_PRODUCTION,
      ),
      postHogKey: optionalBuildValue(import.meta.env.VITE_POSTHOG_KEY),
      sentryDsn: optionalBuildValue(import.meta.env.VITE_SENTRY_DSN_PROD),
      vapidPublicKey: optionalBuildValue(
        import.meta.env.VITE_VAPID_PUBLIC_KEY_PROD,
      ),
    };
  }

  return {
    environment,
    clerkPublishableKey: requiredBuildValue(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY_PREVIEW,
      "VITE_CLERK_PUBLISHABLE_KEY_PREVIEW",
    ),
    publicArtifactsBaseUrl: "https://cdn.vm7.io",
    zeroHostDomain: "sites.vm7.io",
    plausibleScriptUrl:
      environment === "preview"
        ? optionalBuildValue(import.meta.env.VITE_PLAUSIBLE_SCRIPT_URL_PREVIEW)
        : null,
    postHogKey: null,
    sentryDsn: null,
    vapidPublicKey: optionalBuildValue(
      import.meta.env.VITE_VAPID_PUBLIC_KEY_PREVIEW,
    ),
  };
}

export function resolvePublicArtifactsBaseUrl():
  | "https://cdn.vm0.io"
  | "https://cdn.vm7.io" {
  return resolvePlatformRuntimeConfig().publicArtifactsBaseUrl;
}

export function resolveZeroHostDomain(): "sites.vm0.io" | "sites.vm7.io" {
  return resolvePlatformRuntimeConfig().zeroHostDomain;
}
