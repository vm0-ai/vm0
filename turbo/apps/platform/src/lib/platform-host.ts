import { staticUrlForPublicBrand } from "@okouai/core/public-brand";
import {
  isPlatformProductionHostname,
  okouAppWorkerPreviewJobRef,
} from "@okouai/core/platform-service-origin";

type PlatformEnvironment = "development" | "preview" | "production";
type PlatformPublicBrand = "vm0" | "okou";

interface PlatformServiceStatusConfig {
  readonly issuesUrl: string;
  readonly pageBaseUrl: string;
}

// Resolved from `location` and build-time constants alone. The shared database
// SharedWorker is a second entry point into this bundle and has no DOM, so
// nothing here may read page state: every value must come from the hostname or
// from an `import.meta.env` constant that the build inlines.
interface PlatformRuntimeConfig {
  readonly environment: PlatformEnvironment;
  readonly publicBrand: PlatformPublicBrand;
  readonly clerkPublishableKey: string;
  readonly publicArtifactsBaseUrl: "https://cdn.vm0.io" | "https://cdn.vm7.io";
  readonly publicStaticAssetsBaseUrl: string;
  readonly zeroHostDomain: "sites.vm0.io" | "sites.vm7.io";
  readonly plausibleScriptUrl: string | null;
  readonly postHogHost: string | null;
  readonly postHogKey: string | null;
  readonly sentryDsn: string | null;
  readonly vapidPublicKey: string | null;
}

interface PlatformClientTelemetryConfig {
  readonly environment: PlatformEnvironment;
  readonly token: string | null;
}

const OKOU_PRODUCTION_DOMAIN = "okou.ai";
const OKOU_PREVIEW_DOMAIN = "omby.ai";
const OKOU_ROOT_DOMAINS = [
  OKOU_PRODUCTION_DOMAIN,
  OKOU_PREVIEW_DOMAIN,
] as const;
const OFFICE_DOCUMENT_VIEWER_BASE_URL =
  "https://view.officeapps.live.com/op/embed.aspx";
const PRODUCTION_HOSTED_SITE_DOMAINS = ["sites.vm0.io", "okou.app"] as const;
const PREVIEW_HOSTED_SITE_DOMAINS = ["sites.vm7.io"] as const;
const PRODUCTION_SERVICE_STATUS_ISSUES_URL =
  "https://api.instatus.com/issues?locale=en&secretToBypassPrivacy=02c0ef5a&host=status.okou.ai";
const PRODUCTION_SERVICE_STATUS_PAGE_BASE_URL = "https://status.okou.ai";

function browserHostname(): string | null {
  if (typeof location === "undefined" || !location.hostname) {
    return null;
  }
  return location.hostname.toLowerCase();
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isOkouHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/:\d+$/u, "");
  return (
    OKOU_ROOT_DOMAINS.some((domain) => {
      return isDomainOrSubdomain(normalizedHostname, domain);
    }) || okouAppWorkerPreviewJobRef(normalizedHostname) !== null
  );
}

export function resolvePlatformServiceStatusConfig(
  hostname: string,
): PlatformServiceStatusConfig | null {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === "app.vm0.ai" ||
    normalizedHostname === "app.okou.ai"
    ? {
        issuesUrl: PRODUCTION_SERVICE_STATUS_ISSUES_URL,
        pageBaseUrl: PRODUCTION_SERVICE_STATUS_PAGE_BASE_URL,
      }
    : null;
}

function resolvePlatformPublicBrand(
  hostname: string | null,
): PlatformPublicBrand {
  if (!hostname) {
    return "vm0";
  }
  return isOkouHostname(hostname) ? "okou" : "vm0";
}

export function resolvePlatformEnvironment(): PlatformEnvironment {
  const hostname = browserHostname();
  if (!hostname) {
    return "preview";
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "development";
  }

  return isPlatformProductionHostname(hostname) ? "production" : "preview";
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

export function resolvePlatformClientTelemetryConfig(): PlatformClientTelemetryConfig {
  const environment = resolvePlatformEnvironment();
  return {
    environment,
    token:
      environment === "production"
        ? optionalBuildValue(import.meta.env.VITE_AXIOM_CLIENT_TELEMETRY_TOKEN)
        : null,
  };
}

export function resolvePlatformRuntimeConfig(): PlatformRuntimeConfig {
  const clientTelemetryConfig = resolvePlatformClientTelemetryConfig();
  const { environment } = clientTelemetryConfig;
  const publicBrand = resolvePlatformPublicBrand(browserHostname());
  const publicStaticAssetsBaseUrl = staticUrlForPublicBrand(
    "https://static.vm0.io",
    publicBrand,
  );

  if (environment === "production") {
    return {
      environment,
      publicBrand,
      // Both keys are inlined into every artifact and selected by hostname,
      // mirroring the early bootstrap in index.html. Keep the two selections
      // in step; src/__tests__/clerk-entrypoint.test.ts pins them together.
      clerkPublishableKey: requiredBuildValue(
        import.meta.env.VITE_CLERK_PUBLISHABLE_KEY_PROD,
        "VITE_CLERK_PUBLISHABLE_KEY_PROD",
      ),
      publicArtifactsBaseUrl: "https://cdn.vm0.io",
      publicStaticAssetsBaseUrl,
      zeroHostDomain: "sites.vm0.io",
      plausibleScriptUrl: optionalBuildValue(
        import.meta.env.VITE_PLAUSIBLE_SCRIPT_URL_PRODUCTION,
      ),
      postHogHost: "https://j.okou.io",
      postHogKey: optionalBuildValue(import.meta.env.VITE_POSTHOG_KEY),
      sentryDsn: optionalBuildValue(import.meta.env.VITE_SENTRY_DSN_PROD),
      vapidPublicKey: optionalBuildValue(
        import.meta.env.VITE_VAPID_PUBLIC_KEY_PROD,
      ),
    };
  }

  return {
    environment,
    publicBrand,
    clerkPublishableKey: requiredBuildValue(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY_PREVIEW,
      "VITE_CLERK_PUBLISHABLE_KEY_PREVIEW",
    ),
    publicArtifactsBaseUrl: "https://cdn.vm7.io",
    publicStaticAssetsBaseUrl,
    zeroHostDomain: "sites.vm7.io",
    plausibleScriptUrl:
      environment === "preview"
        ? optionalBuildValue(import.meta.env.VITE_PLAUSIBLE_SCRIPT_URL_PREVIEW)
        : null,
    postHogHost: null,
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

export function resolveOfficeDocumentViewerBaseUrl(): string {
  return OFFICE_DOCUMENT_VIEWER_BASE_URL;
}

export function resolveHostedSiteDomains(): readonly (
  | "sites.vm0.io"
  | "okou.app"
  | "sites.vm7.io"
)[] {
  return resolvePlatformEnvironment() === "production"
    ? PRODUCTION_HOSTED_SITE_DOMAINS
    : PREVIEW_HOSTED_SITE_DOMAINS;
}
