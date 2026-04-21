import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import {
  runLayers,
  corsLayer,
  authRedirectLayer,
  legalRedirectLayer,
  localeGuardLayer,
  i18nLayer,
  isProtectedSkipRoute,
  classifyRoute,
} from "./proxy.layers";
import { handleCors } from "./proxy.cors";

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
  "/terms-of-use",
  "/privacy-policy",
  "/support",
  "/:locale/terms-of-use",
  "/:locale/privacy-policy",
  "/:locale/support",
  "/design-system",
  "/:locale/design-system",
  "/blog",
  "/blog/posts/:slug",
  "/:locale/blog",
  "/:locale/blog/posts/:slug",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/sign-in-token",
  "/:locale/sign-in-token",
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

  return runLayers(request, [
    corsLayer,
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
  // Handle CORS preflight before Clerk — OPTIONS requests carry no credentials,
  // and Clerk may add x-middleware-next to the response which prevents Next.js
  // from returning our 200 directly.
  if (
    request.method === "OPTIONS" &&
    request.nextUrl.pathname.startsWith("/api/")
  ) {
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
    return NextResponse.next();
  }

  // Self-signed tokens (sandbox, PAT) are only consumed by /api/* endpoints.
  // Bypass Clerk for those paths so it doesn't try to parse the non-JWT token.
  // For non-API paths (pages, bot/scanner traffic), strip the header before
  // calling Clerk so auth() in server components resolves to an anonymous
  // session instead of throwing "clerkMiddleware not detected".
  if (hasSelfSignedToken) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.next();
    }
    const scrubbedHeaders = new Headers(request.headers);
    scrubbedHeaders.delete("authorization");
    const scrubbedRequest = new NextRequest(request, {
      headers: scrubbedHeaders,
    });
    return clerk(scrubbedRequest, event);
  }

  return clerk(request, event);
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
