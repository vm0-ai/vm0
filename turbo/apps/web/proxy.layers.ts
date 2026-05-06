import { NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { locales, defaultLocale } from "./i18n";

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

/**
 * Routes that should skip i18n processing entirely.
 * These include API routes, static files, auth pages, and Next.js internals.
 */
const SKIP_I18N_PREFIXES = [
  "/api/",
  "/_next/",
  "/cli-auth",
  "/connector/",
  "/slack/",
  "/sign-in",
  "/sign-in-token",
  "/sign-up",
  "/privacy-policy",
  "/terms-of-use",
  "/support",
  "/export",
  "/f/",
] as const;

const STATIC_FILE_RE = /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i;

/**
 * Classify a request into one of three categories:
 * - "api"   : /api/* routes that need CORS handling
 * - "skip"  : non-API routes that should bypass i18n (static, auth pages, etc.)
 * - "page"  : normal page routes that need i18n + auth
 */
type RouteKind = "api" | "skip" | "page";

export function classifyRoute(pathname: string): RouteKind {
  if (pathname.startsWith("/api/")) {
    return "api";
  }

  for (const prefix of SKIP_I18N_PREFIXES) {
    if (pathname.startsWith(prefix)) return "skip";
  }

  if (pathname.includes("/assets/") || STATIC_FILE_RE.test(pathname)) {
    return "skip";
  }

  return "page";
}

// ---------------------------------------------------------------------------
// Shared route matchers
// ---------------------------------------------------------------------------

/** Routes that require a logged-in user even outside the i18n flow */
const PROTECTED_SKIP_PREFIXES = ["/cli-auth"] as const;

export function isProtectedSkipRoute(pathname: string): boolean {
  return PROTECTED_SKIP_PREFIXES.some((p) => {
    return pathname.startsWith(p);
  });
}

// ---------------------------------------------------------------------------
// i18n middleware
// ---------------------------------------------------------------------------

const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
  localeDetection: true,
  alternateLinks: false,
});

// ---------------------------------------------------------------------------
// Proxy layer types
// ---------------------------------------------------------------------------

type ProxyContext = {
  request: NextRequest;
  routeKind: RouteKind;
};

/**
 * A proxy layer function.
 *
 * Returning a `NextResponse` short-circuits the chain. Returning `null`
 * passes control to the next layer (onion model).
 */
type ProxyLayer = (
  ctx: ProxyContext,
) => Promise<NextResponse | null | undefined> | NextResponse | null | undefined;

/**
 * Run layers in order. The first layer to return a response wins.
 * If no layer returns a response, fall through with `NextResponse.next()`.
 */
export async function runLayers(
  request: NextRequest,
  layers: ProxyLayer[],
): Promise<NextResponse> {
  const routeKind = classifyRoute(request.nextUrl.pathname);
  const ctx: ProxyContext = { request, routeKind };

  for (const layer of layers) {
    const response = await layer(ctx);
    if (response) return response;
  }

  return NextResponse.next();
}

// ---------------------------------------------------------------------------
// Shared layers
// ---------------------------------------------------------------------------

/**
 * Redirect locale-prefixed auth paths (e.g. /en/sign-up) to the root auth
 * pages (/sign-up). Auth pages live outside the [locale] route tree, so
 * /:locale/sign-up would 404 without this redirect.
 */
const LOCALE_AUTH_RE = /^\/(\w{2})\/(sign-in|sign-up)(\/.*)?$/;

export const authRedirectLayer: ProxyLayer = (ctx) => {
  const match = ctx.request.nextUrl.pathname.match(LOCALE_AUTH_RE);
  if (match && locales.includes(match[1] as (typeof locales)[number])) {
    const target = new URL(ctx.request.nextUrl);
    target.pathname = `/${match[2]}${match[3] ?? ""}`;
    return NextResponse.redirect(target, 308);
  }
  return null;
};

/**
 * Redirect locale-prefixed legal / utility pages (e.g. /en/privacy-policy) to
 * the root paths (/privacy-policy). These pages live outside the [locale]
 * route tree: legal pages use Termly iframe embeds (Termly handles its own
 * language) and /support is English-only per Slack App Directory guidelines.
 */
const LOCALE_LEGAL_RE =
  /^\/(\w{2})\/(privacy-policy|terms-of-use|support)(\/.*)?$/;

export const legalRedirectLayer: ProxyLayer = (ctx) => {
  const match = ctx.request.nextUrl.pathname.match(LOCALE_LEGAL_RE);
  if (match && locales.includes(match[1] as (typeof locales)[number])) {
    const target = new URL(ctx.request.nextUrl);
    target.pathname = `/${match[2]}${match[3] ?? ""}`;
    return NextResponse.redirect(target, 308);
  }
  return null;
};

/**
 * Reject requests where the first path segment looks like a locale slot
 * but is not a supported locale (e.g. `/favicon.ico/blog`).
 * Returns 404 so crawlers and bots don't trigger i18n errors.
 */
export const localeGuardLayer: ProxyLayer = (ctx) => {
  if (ctx.routeKind !== "page") return null;

  const firstSegment = ctx.request.nextUrl.pathname.split("/")[1];
  if (
    firstSegment &&
    !locales.includes(firstSegment as (typeof locales)[number]) &&
    firstSegment.includes(".")
  ) {
    return new NextResponse(null, { status: 404 });
  }
  return null;
};

/**
 * Apply i18n for page routes.
 *
 * next-intl redirects locale-less paths (e.g. /use-cases/foo, /) with 307
 * (temporary). We upgrade them to 301 so search engines consolidate PageRank
 * on the canonical /:locale/… URL. The sitemap and canonical/hreflang tags
 * all point at the locale-prefixed form, so there is no need to keep a
 * locale-less variant indexable.
 */
export const i18nLayer: ProxyLayer = (ctx) => {
  if (ctx.routeKind === "page") {
    const response = intlMiddleware(ctx.request);
    const location = response.headers.get("location");
    if (location) {
      const url = new URL(location, ctx.request.nextUrl.origin);
      return NextResponse.redirect(url, 301);
    }
    return response;
  }
  return null;
};
