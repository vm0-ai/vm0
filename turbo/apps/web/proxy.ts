import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import {
  runLayers,
  authRedirectLayer,
  legalRedirectLayer,
  localeGuardLayer,
  i18nLayer,
  isProtectedSkipRoute,
  classifyRoute,
} from "./proxy.layers";
import { applyCorsHeaders, handleCors } from "./proxy.cors";
import { env } from "./src/env";
import {
  matchesApiBackendRewritePath,
  matchesOAuthWebOriginRewritePath,
} from "./api-backend-rewrites";

// ---------------------------------------------------------------------------
// Clerk-specific route config
// ---------------------------------------------------------------------------

const isPublicRoute = createRouteMatcher([
  "/",
  "/:locale",
  "/pricing",
  "/:locale/pricing",
  "/security",
  "/:locale/security",
  "/use-cases",
  "/use-cases/:slug",
  "/:locale/use-cases",
  "/:locale/use-cases/:slug",
  "/:locale/use-cases/:slug/opengraph-image",
  "/rankings",
  "/:locale/rankings",
  "/web-design",
  "/:locale/web-design",
  "/showcase",
  "/:locale/showcase",
  "/terms-of-use",
  "/privacy-policy",
  "/support",
  "/:locale/terms-of-use",
  "/:locale/privacy-policy",
  "/:locale/support",
  "/design-system",
  "/:locale/design-system",
  "/models",
  "/models/:slug",
  "/:locale/models",
  "/:locale/models/:slug",
  "/blog",
  "/blog/posts/:slug",
  "/:locale/blog",
  "/:locale/blog/posts/:slug",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/sign-in-token",
  "/:locale/sign-in-token",
  "/desktop-auth/start(.*)",
  "/desktop-auth/callback(.*)",
  "/desktop-auth/consume(.*)",
  "/desktop-auth/select-org(.*)",
  "/desktop-auth/token(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
  "/api/slack/oauth/(.*)",
  "/slack/success",
  "/slack/failed",
  "/robots.txt",
  "/sitemap.xml",
]);

/**
 * Token prefixes for self-signed JWTs.
 * Clerk cannot parse these tokens because they are not standard JWTs
 * (they have a non-base64 prefix). We must strip the Authorization header
 * before the request reaches Clerk middleware, and restore it via a
 * forwarding header so route handlers can still authenticate.
 */
const SANDBOX_TOKEN_PREFIX = "vm0_sandbox_";
const PAT_TOKEN_PREFIX = "vm0_pat_";
const TEST_ENDPOINT_BYPASS_HEADER = "x-vm0-test-endpoint-bypass";
const OAUTH_WEB_ORIGIN_HEADER = "x-vm0-web-origin";

function apiBackendProxyPassThrough(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-forwarded-host", request.nextUrl.host);
  requestHeaders.set(
    "x-forwarded-proto",
    request.nextUrl.protocol.slice(0, -1),
  );
  if (matchesOAuthWebOriginRewritePath(request.nextUrl.pathname)) {
    requestHeaders.set(OAUTH_WEB_ORIGIN_HEADER, request.nextUrl.origin);
  }
  const bypass = env().VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) {
    requestHeaders.set("x-vercel-protection-bypass", bypass);
    if (request.nextUrl.pathname.startsWith("/api/test/")) {
      requestHeaders.set(TEST_ENDPOINT_BYPASS_HEADER, bypass);
    }
  }

  return applyCorsHeaders(
    request,
    NextResponse.next({ request: { headers: requestHeaders } }),
  );
}

// ---------------------------------------------------------------------------
// Clerk middleware (inner)
// ---------------------------------------------------------------------------

const clerk = clerkMiddleware(async (auth, request: NextRequest) => {
  const routeKind = classifyRoute(request.nextUrl.pathname);

  // Clerk auth: protect non-public routes (official inline pattern)
  if (routeKind === "skip") {
    if (isProtectedSkipRoute(request.nextUrl.pathname)) {
      await auth.protect();
    }
  } else if (routeKind === "page") {
    if (!isPublicRoute(request)) {
      await auth.protect();
    }
  }

  // CORS for API routes is handled in the outer middleware (before Clerk),
  // so we skip corsLayer here. Only non-API layers remain.
  return runLayers(request, [
    authRedirectLayer,
    legalRedirectLayer,
    localeGuardLayer,
    i18nLayer,
  ]);
});

// ---------------------------------------------------------------------------
// Outer middleware: shield Clerk from non-Clerk tokens
// ---------------------------------------------------------------------------

/**
 * Wraps the Clerk middleware to prevent it from crashing on non-standard
 * Bearer tokens (e.g. vm0_sandbox_ prefixed JWTs).
 *
 * When a sandbox token is detected, we:
 * 1. Strip the Authorization header so Clerk sees an unauthenticated request
 * 2. Store the original value in x-vm0-authorization
 * 3. After Clerk runs, copy x-vm0-authorization back to Authorization
 *    in the response headers so the downstream route handler receives it
 */
export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");
  const isApiBackendProxyRoute = matchesApiBackendRewritePath(
    request.nextUrl.pathname,
  );

  // Handle CORS preflight before Clerk — OPTIONS requests carry no credentials,
  // and Clerk may add x-middleware-next to the response which prevents Next.js
  // from returning our 200 directly.
  if (isApiRoute && request.method === "OPTIONS") {
    return handleCors(request);
  }

  const authHeader = request.headers.get("authorization");
  const hasSelfSignedToken =
    authHeader?.startsWith("Bearer " + SANDBOX_TOKEN_PREFIX) ||
    authHeader?.startsWith("Bearer " + PAT_TOKEN_PREFIX);

  // v1 API surface authenticates exclusively via Clerk-issued API Keys
  // (verified server-side). Bypass Clerk middleware entirely so its session
  // detection never touches the opaque Bearer tokens it cannot parse.
  if (request.nextUrl.pathname.startsWith("/api/v1/")) {
    return handleCors(request);
  }

  if (isApiBackendProxyRoute) {
    return apiBackendProxyPassThrough(request);
  }

  // Self-signed tokens (sandbox, PAT) are only consumed by /api/* endpoints.
  // Bypass Clerk for those paths so it doesn't try to parse the non-JWT token.
  // For non-API paths (pages, bot/scanner traffic), strip the header before
  // calling Clerk so auth() in server components resolves to an anonymous
  // session instead of throwing "clerkMiddleware not detected".
  if (hasSelfSignedToken) {
    if (isApiRoute) {
      return handleCors(request);
    }
    const scrubbedHeaders = new Headers(request.headers);
    scrubbedHeaders.delete("authorization");
    const scrubbedRequest = new NextRequest(request, {
      headers: scrubbedHeaders,
    });
    return clerk(scrubbedRequest, event);
  }

  const response = await clerk(request, event);

  // API responses from Clerk carry no CORS headers — the inner `corsLayer`
  // was removed so Clerk's auth.protect() redirects aren't shadowed by a
  // CORS early-return. Apply response-side CORS headers here so browsers can
  // read cross-origin authenticated responses. Preflight is handled above,
  // so only Allow-Origin and Allow-Credentials are needed for actual
  // requests. `handleCors` performs origin-allowlist validation.
  if (isApiRoute && response) {
    const allowOrigin = handleCors(request).headers.get(
      "Access-Control-Allow-Origin",
    );
    if (allowOrigin) {
      response.headers.set("Access-Control-Allow-Origin", allowOrigin);
      response.headers.set("Access-Control-Allow-Credentials", "true");
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Match all routes except:
    // - _next (Next.js internals)
    // - _vercel (Vercel internals)
    // - assets (static assets)
    // - files with extensions (images, fonts, etc.)
    // - sign-in and sign-up (Clerk auth pages, no i18n)
    "/((?!_next|_vercel|assets|sign-in|sign-up|.*\\..*).*)",
    // Match API routes for CORS handling
    "/(api|v1|trpc)(.*)",
  ],
};
