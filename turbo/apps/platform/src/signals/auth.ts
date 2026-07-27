import { Clerk } from "@clerk/clerk-js";
import { ui } from "@clerk/ui";
import { command, computed, state } from "ccstate";
import { clearSentryUser, setSentryUser } from "../lib/sentry.ts";
import { clearPostHogUser, setPostHogUser } from "../lib/posthog.ts";
import { appendCapturedPreviewBypassToUrl } from "../lib/preview-bypass-cookie.ts";
import {
  derivePlatformServiceOrigin,
  isProductionSatelliteHostname,
  PRODUCTION_SATELLITE_HOSTNAME,
  type PlatformService,
  resolvePlatformEnvironment,
  resolvePlatformRuntimeConfig,
} from "../lib/platform-host.ts";
import { bestEffort, onDomEventFn } from "./utils.ts";

const reload$ = state(0);
const clerkVersion$ = state(0);

const ATTRIBUTION_SOURCE_PARAM = "vm0_source";
const HOMEPAGE_ATTRIBUTION_VALUE = "homepage";
const VM0_ONBOARDING_PATH = "/onboarding";
const CLERK_PRIMARY_APP_ORIGIN = "https://app.vm0.ai";
const CLERK_SATELLITE_REDIRECT_ORIGIN_PATTERN =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*okou\.ai(?::\d+)?$/i;

type AllowedAuthRedirectOrigin = string | RegExp;

interface ClerkSatelliteConfig {
  readonly domain: typeof PRODUCTION_SATELLITE_HOSTNAME;
  readonly isSatellite: true;
  readonly satelliteAutoSync: true;
}

const AD_ATTRIBUTION_PARAMS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const AD_TRAFFIC_MARKERS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_campaign",
] as const;

const HTTP_URL_PREFIX_REGEX = /^https?:\/\//i;
const LEGACY_HTTP_URL_REGEX = /^https?:\/\/([^/?#\s]+)([/?#][^\s]*)?$/i;
const LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/i;
const MAX_URL_PORT = 65_535;

// Derive a sibling service origin from a public origin, keeping protocol and
// port: https://app.vm7.ai:8443 + "www" -> https://www.vm7.ai:8443. No
// environment fallback — a wrong-environment URL is silent and sticks, while
// an error here surfaces the actual bug.
export function deriveServiceOrigin(
  currentOrigin: string,
  service: Extract<PlatformService, "www" | "app" | "api">,
): string {
  return derivePlatformServiceOrigin(currentOrigin, service);
}

// The WWW origin sibling of the current host.
export function resolveWebOrigin(): string {
  const origin = location.origin;
  if (!origin || origin === "null") {
    throw new Error("Cannot resolve the www origin without a browser origin");
  }
  return deriveServiceOrigin(origin, "www");
}

function resolveAppOrigin(): string {
  const origin = location.origin;
  return !origin || origin === "null" ? "" : origin;
}

export function resolveClerkSatelliteConfig(): ClerkSatelliteConfig | null {
  if (
    typeof location === "undefined" ||
    !isProductionSatelliteHostname(location.hostname)
  ) {
    return null;
  }

  return {
    domain: PRODUCTION_SATELLITE_HOSTNAME,
    isSatellite: true,
    satelliteAutoSync: true,
  };
}

function resolveAuthOrigin(): string {
  return resolveClerkSatelliteConfig()
    ? CLERK_PRIMARY_APP_ORIGIN
    : resolveAppOrigin();
}

function parseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!HTTP_URL_PREFIX_REGEX.test(trimmed)) {
    return null;
  }

  if (typeof URL.canParse === "function") {
    return URL.canParse(trimmed) ? new URL(trimmed) : null;
  }

  const legacyMatch = LEGACY_HTTP_URL_REGEX.exec(trimmed);
  const host = legacyMatch?.[1];
  if (!host) {
    return null;
  }

  const hostMatch = LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX.exec(host);
  const port = hostMatch?.[2];
  if (!hostMatch || (port && Number(port) > MAX_URL_PORT)) {
    return null;
  }

  return new URL(trimmed);
}

export function resolveAppUrl(): string {
  return resolveAppOrigin();
}

export function resolveWebAuthUrl(
  path: `/sign-${string}`,
  options: { redirectUrl?: string } = {},
): string {
  const webOrigin = resolveWebOrigin();
  if (!webOrigin) {
    return path;
  }
  const url = new URL(path, webOrigin);
  if (options.redirectUrl) {
    url.searchParams.set("redirect_url", options.redirectUrl);
  }
  appendCapturedPreviewBypassToUrl(url);
  return url.toString();
}

export function resolveAppAuthUrl(
  path: `/sign-${string}`,
  options: { redirectUrl?: string } = {},
): string {
  const appOrigin = resolveAuthOrigin();
  if (!appOrigin) {
    return path;
  }
  const url = new URL(path, appOrigin);
  if (options.redirectUrl) {
    url.searchParams.set("redirect_url", options.redirectUrl);
  }
  return url.toString();
}

// Clerk allowedRedirectOrigins for the current host: this app plus its www
// and api siblings. Production also includes the satellite domain family and
// primary app so Clerk can safely return between app.vm0.ai and *.okou.ai.
export function getAllowedAuthRedirectOrigins(): AllowedAuthRedirectOrigin[] {
  const self = resolveAppOrigin();
  if (!self) {
    return [];
  }
  const productionOrigins =
    resolvePlatformEnvironment() === "production"
      ? [CLERK_PRIMARY_APP_ORIGIN, CLERK_SATELLITE_REDIRECT_ORIGIN_PATTERN]
      : [];
  return [
    ...new Set([
      self,
      deriveServiceOrigin(self, "www"),
      deriveServiceOrigin(self, "api"),
      ...productionOrigins,
    ]),
  ];
}

export function getAllowedAuthRedirectOriginsForCurrentPage(): AllowedAuthRedirectOrigin[] {
  return getAllowedAuthRedirectOrigins();
}

function hasAdTraffic(params: URLSearchParams): boolean {
  return AD_TRAFFIC_MARKERS.some((param) => {
    return params.has(param);
  });
}

function appendHomepageAttributionParams(
  url: URLSearchParams,
  landingSearch: string,
): void {
  const landingParams = new URLSearchParams(landingSearch);
  url.set(ATTRIBUTION_SOURCE_PARAM, HOMEPAGE_ATTRIBUTION_VALUE);
  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of landingParams.getAll(param)) {
      url.append(param, value);
    }
  }
}

function setCurrentLandingContext(params: URLSearchParams): void {
  if (!params.has("landing_host")) {
    params.set("landing_host", location.hostname);
  }
  if (!params.has("landing_path")) {
    params.set("landing_path", location.pathname);
  }
}

function buildVm0OnboardingEntryUrl(paramsInit?: URLSearchParams): string {
  const params = new URLSearchParams(paramsInit);
  setCurrentLandingContext(params);
  const url = new URL(VM0_ONBOARDING_PATH, resolveAppOrigin());
  url.search = params.toString();
  appendCapturedPreviewBypassToUrl(url);
  return url.toString();
}

function isAllowedRedirectOrigin(
  redirectUrl: URL,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[],
): boolean {
  return allowedRedirectOrigins.some((allowedOrigin) => {
    if (allowedOrigin instanceof RegExp) {
      return allowedOrigin.test(redirectUrl.origin);
    }
    const url = parseUrl(allowedOrigin);
    if (!url) {
      return false;
    }
    return url.origin === redirectUrl.origin;
  });
}

function readAllowedRedirectUrl(
  params: URLSearchParams,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[],
): string | null {
  const rawRedirectUrl = params.get("redirect_url");
  if (!rawRedirectUrl) {
    return null;
  }

  const redirectUrl = parseUrl(rawRedirectUrl);
  if (!redirectUrl) {
    return null;
  }
  return isAllowedRedirectOrigin(redirectUrl, allowedRedirectOrigins)
    ? redirectUrl.toString()
    : null;
}

export function buildSignupRedirectUrl(
  signUpSearch: string,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[] = getAllowedAuthRedirectOriginsForCurrentPage(),
): string {
  const appUrl = resolveAppUrl();
  const params = new URLSearchParams(signUpSearch);
  const redirectUrl = readAllowedRedirectUrl(params, allowedRedirectOrigins);
  if (redirectUrl) {
    return redirectUrl;
  }

  if (!hasAdTraffic(params)) {
    return appUrl;
  }

  const redirectParams = new URLSearchParams();
  appendHomepageAttributionParams(redirectParams, signUpSearch);
  return buildVm0OnboardingEntryUrl(redirectParams);
}

export function buildSignInRedirectUrl(
  signInSearch: string,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[] = getAllowedAuthRedirectOriginsForCurrentPage(),
): string {
  const params = new URLSearchParams(signInSearch);
  const redirectUrl = readAllowedRedirectUrl(params, allowedRedirectOrigins);

  return redirectUrl ?? resolveAppUrl();
}

export const clerkUi$ = computed(() => {
  return ui;
});

/**
 * Construct Clerk synchronously so the React provider can subscribe before
 * loading starts. Passing an already-loaded instance can make the provider
 * miss Clerk's ready event and leave hosted auth UI in its loading fallback.
 */
export const clerkInstance$ = computed(() => {
  const publishableKey = resolvePlatformRuntimeConfig().clerkPublishableKey;
  const satelliteConfig = resolveClerkSatelliteConfig();

  const { ClerkUI } = ui;
  if (!ClerkUI) {
    throw new Error("Clerk UI module did not provide its renderer");
  }

  return satelliteConfig
    ? new Clerk(publishableKey, { domain: satelliteConfig.domain })
    : new Clerk(publishableKey);
});

/**
 * Loaded Clerk instance for consumers that need authentication state.
 */
export const clerk$ = computed(async (get) => {
  const clerkInstance = get(clerkInstance$);
  const satelliteConfig = resolveClerkSatelliteConfig();

  await clerkInstance.load({
    ui,
    ...(satelliteConfig
      ? {
          isSatellite: true,
          satelliteAutoSync: satelliteConfig.satelliteAutoSync,
        }
      : {}),
    signInUrl: resolveAppAuthUrl("/sign-in"),
    signUpUrl: resolveAppAuthUrl("/sign-up"),
    afterSignOutUrl: resolveAppAuthUrl("/sign-in"),
  });
  return clerkInstance;
});

/**
 * Command to setup Clerk authentication listeners.
 * This command initializes the Clerk instance and sets up a listener
 * for authentication state changes.
 */
export const setupClerk$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    // Set initial Sentry user context
    if (clerk.user) {
      setSentryUser(clerk.user.id);
      setPostHogUser({
        id: clerk.user.id,
        email: clerk.user.primaryEmailAddress?.emailAddress,
        name: clerk.user.fullName ?? undefined,
      });
    }

    // Track the user ID so we only trigger a reload on actual auth state
    // changes (sign-in / sign-out), not on token refreshes which fire the
    // Clerk listener but don't change the user.
    let prevUserId = clerk.user?.id ?? null;
    const unsubscribe = clerk.addListener(() => {
      // Update Sentry user context on auth state change
      if (clerk.user) {
        setSentryUser(clerk.user.id);
        setPostHogUser({
          id: clerk.user.id,
          email: clerk.user.primaryEmailAddress?.emailAddress,
          name: clerk.user.fullName ?? undefined,
        });
      } else {
        clearSentryUser();
        clearPostHogUser();
      }
      // Bump on every clerk event so signals tracking mutable clerk state
      // (e.g. current org's imageUrl after reload()) re-compute and their
      // subscribers re-render.
      set(clerkVersion$, (x) => {
        return x + 1;
      });
      const currentUserId = clerk.user?.id ?? null;
      if (currentUserId !== prevUserId) {
        prevUserId = currentUserId;
        set(reload$, (x) => {
          return x + 1;
        });
      }
    });
    signal.addEventListener("abort", unsubscribe);
  },
);

/**
 * User signal that provides the current authenticated user from Clerk.
 * Returns undefined if no user is authenticated.
 */
const ORG_ID_KEY = "clerk-active-org-id";

function persistOrgId(orgId: string | undefined) {
  if (orgId) {
    sessionStorage.setItem(ORG_ID_KEY, orgId);
  } else {
    sessionStorage.removeItem(ORG_ID_KEY);
  }
}

/**
 * Command that monitors the active Clerk organization and reloads
 * the page when it changes. Persists the active org ID to session storage.
 */
export const watchOrgSwitch$ = command(async ({ get }, signal: AbortSignal) => {
  const clerk = await get(clerk$);
  signal.throwIfAborted();

  let prevOrgId = sessionStorage.getItem(ORG_ID_KEY) ?? undefined;
  const currentOrgId = clerk.organization?.id ?? undefined;
  prevOrgId = currentOrgId;
  persistOrgId(currentOrgId);

  // Listener stays `() => void`: Clerk's `ListenerCallback` signature
  // is not awaited, and returning a promise from it would trip
  // `typescript/no-misused-promises`. `onDomEventFn` detaches the async
  // work, and `bestEffort` keeps reload behavior even when token rotation
  // rejects.
  const unsubscribe = clerk.addListener(
    onDomEventFn(async () => {
      const newOrgId = clerk.organization?.id ?? undefined;
      if (newOrgId === prevOrgId) {
        return;
      }
      prevOrgId = newOrgId;
      persistOrgId(newOrgId);
      // On mobile, Clerk can transiently clear clerk.organization to
      // undefined during a background token refresh before restoring it on
      // the next event. Guard against that by only reloading when the
      // session is landing on a concrete org (org_A→org_B or
      // undefined→org_A). An org disappearing to undefined is treated as a
      // transient state; the listener will fire again with the real org_id.
      if (!newOrgId) {
        return;
      }

      await bestEffort(
        (async () => {
          return await clerk.session?.getToken({ skipCache: true });
        })(),
      );
      location.href = "/";
    }),
  );
  signal.addEventListener("abort", unsubscribe);
});

export const user$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  return clerk.user ?? undefined;
});

/**
 * Stable cache ownership for authenticated pages.
 *
 * Route setup guarantees both values before page data is loaded. Keeping this
 * invariant here prevents cache-backed data sources from independently
 * treating a missing Clerk value as an empty cache or a remote-only mode.
 */
export const authenticatedIdentity$ = computed(async (get) => {
  const clerk = await get(clerk$);
  if (!clerk.user || !clerk.organization) {
    throw new Error("Authenticated user and organization are required");
  }
  return {
    userId: clerk.user.id,
    orgId: clerk.organization.id,
    email: clerk.user.primaryEmailAddress?.emailAddress,
  };
});

export const currentUserInfo$ = computed(async (get) => {
  get(clerkVersion$);
  const clerk = await get(clerk$);
  const user = clerk.user;
  if (!user) {
    return undefined;
  }
  return {
    id: user.id,
    fullName: user.fullName,
    firstName: user.firstName,
    imageUrl: user.imageUrl,
    primaryEmailAddress: user.primaryEmailAddress
      ? {
          emailAddress: user.primaryEmailAddress.emailAddress,
        }
      : null,
  };
});

/**
 * Snapshot of the Clerk active organization, re-emitted on every clerk
 * event (via clerkVersion$). Read this instead of `clerk.organization.*`
 * directly when you want the UI to react to in-place mutations such as
 * `clerk.organization.reload()` after a logo or name update.
 */
export const currentOrgInfo$ = computed(async (get) => {
  get(clerkVersion$);
  const clerk = await get(clerk$);
  const org = clerk.organization;
  if (!org) {
    return null;
  }
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    imageUrl: org.imageUrl,
    hasImage: org.hasImage,
  };
});

/**
 * Determines whether the current user needs to select an organization
 * before entering the platform.
 *
 * Returns true when ALL of:
 * - No active organization is set in the Clerk session
 * - AND at least one of:
 *   - User belongs to more than 1 organization
 *   - User has pending organization invitations
 *
 */
export const needsOrgSelection$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  const user = clerk.user;
  if (!user) {
    return false;
  }

  // If an active organization is already set, no selection needed
  if (clerk.organization) {
    return false;
  }

  // No active organization — user must select or create one
  return true;
});
