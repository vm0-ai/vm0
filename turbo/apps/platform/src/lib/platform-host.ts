import { staticUrlForPublicBrand } from "@okouai/core/public-brand";

type PlatformEnvironment = "development" | "preview" | "production";
type PlatformPublicBrand = "vm0" | "okou";

export type PlatformService = "api" | "www" | "app" | "platform";

export interface PlatformServiceStatusConfig {
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

const PRODUCTION_DOMAIN = "vm0.ai";
const OKOU_PRODUCTION_DOMAIN = "okou.ai";
const OKOU_PREVIEW_DOMAIN = "omby.ai";
const OKOU_APP_WORKER_PREVIEW_HOST_PATTERN =
  /^((?:staging|pr-[0-9]+))-app-okou-app-preview\.vm0\.workers\.dev$/u;
const OKOU_ROOT_DOMAINS = [
  OKOU_PRODUCTION_DOMAIN,
  OKOU_PREVIEW_DOMAIN,
] as const;
const PREVIEW_API_DOMAIN = "vm6.ai";
const OFFICE_DOCUMENT_VIEWER_BASE_URL =
  "https://view.officeapps.live.com/op/embed.aspx";
const PRODUCTION_HOSTED_SITE_DOMAINS = ["sites.vm0.io", "okou.app"] as const;
const PREVIEW_HOSTED_SITE_DOMAINS = ["sites.vm7.io"] as const;
const PLATFORM_SERVICE_LABELS = ["platform", "app", "www", "api"] as const;
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

export function okouAppWorkerPreviewJobRef(hostname: string): string | null {
  return (
    OKOU_APP_WORKER_PREVIEW_HOST_PATTERN.exec(hostname.toLowerCase())?.[1] ??
    null
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

export function isOkouProductionHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return isDomainOrSubdomain(normalizedHostname, OKOU_PRODUCTION_DOMAIN);
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
  const workerPreviewJobRef = okouAppWorkerPreviewJobRef(hostname);
  if (workerPreviewJobRef) {
    if (target === "app") {
      return hostname;
    }
    const targetDomain =
      target === "api" ? PREVIEW_API_DOMAIN : OKOU_PREVIEW_DOMAIN;
    return `${workerPreviewJobRef}-${target}.${targetDomain}`;
  }

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
  // hostname. Okou keeps its API identity while web and auth services remain
  // canonical on vm0.ai.
  const productionDomain =
    target === "api" && isOkouProductionHostname(url.hostname)
      ? OKOU_PRODUCTION_DOMAIN
      : PRODUCTION_DOMAIN;
  url.hostname = isProductionHostname(url.hostname)
    ? `${target}.${productionDomain}`
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
