import { NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { handleCors } from "./middleware.cors";
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
  "/sign-up",
] as const;

const STATIC_FILE_RE = /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i;

/**
 * Classify a request into one of three categories:
 * - "api"   : /api/* routes that need CORS handling
 * - "skip"  : non-API routes that should bypass i18n (static, auth pages, etc.)
 * - "page"  : normal page routes that need i18n + auth
 */
type RouteKind = "api" | "skip" | "page";

function classifyRoute(pathname: string): RouteKind {
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
  return PROTECTED_SKIP_PREFIXES.some((p) => pathname.startsWith(p));
}

// ---------------------------------------------------------------------------
// i18n middleware (shared between Clerk and local modes)
// ---------------------------------------------------------------------------

const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
  localeDetection: true,
});

// ---------------------------------------------------------------------------
// Middleware layer types
// ---------------------------------------------------------------------------

type MiddlewareContext = {
  request: NextRequest;
  routeKind: RouteKind;
};

/**
 * A middleware layer function.
 *
 * Returning a `NextResponse` short-circuits the chain. Returning `null`
 * passes control to the next layer (onion model).
 */
export type MiddlewareLayer = (
  ctx: MiddlewareContext,
) => Promise<NextResponse | null | undefined> | NextResponse | null | undefined;

/**
 * Run layers in order. The first layer to return a response wins.
 * If no layer returns a response, fall through with `NextResponse.next()`.
 */
export async function runLayers(
  request: NextRequest,
  layers: MiddlewareLayer[],
): Promise<NextResponse> {
  const routeKind = classifyRoute(request.nextUrl.pathname);
  const ctx: MiddlewareContext = { request, routeKind };

  for (const layer of layers) {
    const response = await layer(ctx);
    if (response) return response;
  }

  return NextResponse.next();
}

// ---------------------------------------------------------------------------
// Shared layers (used by both Clerk and local middleware)
// ---------------------------------------------------------------------------

/**
 * Redirect locale-prefixed auth paths (e.g. /en/sign-up) to the root auth
 * pages (/sign-up). Auth pages live outside the [locale] route tree, so
 * /:locale/sign-up would 404 without this redirect.
 */
const LOCALE_AUTH_RE = /^\/(\w{2})\/(sign-in|sign-up)(\/.*)?$/;

export const authRedirectLayer: MiddlewareLayer = (ctx) => {
  const match = ctx.request.nextUrl.pathname.match(LOCALE_AUTH_RE);
  if (match && locales.includes(match[1] as (typeof locales)[number])) {
    const target = new URL(ctx.request.nextUrl);
    target.pathname = `/${match[2]}${match[3] ?? ""}`;
    return NextResponse.redirect(target, 308);
  }
  return null;
};

/** Handle CORS for API routes. Always short-circuits for "api" routes. */
export const corsLayer: MiddlewareLayer = (ctx) => {
  if (ctx.routeKind === "api") {
    return handleCors(ctx.request);
  }
  return null;
};

/**
 * Reject requests where the first path segment looks like a locale slot
 * but is not a supported locale (e.g. `/favicon.ico/blog`).
 * Returns 404 so crawlers and bots don't trigger i18n errors.
 */
export const localeGuardLayer: MiddlewareLayer = (ctx) => {
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

/** Apply i18n for page routes. */
export const i18nLayer: MiddlewareLayer = (ctx) => {
  if (ctx.routeKind === "page") {
    return intlMiddleware(ctx.request);
  }
  return null;
};
