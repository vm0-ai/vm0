import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent } from "next/server";
import { NextRequest } from "next/server";
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

// ---------------------------------------------------------------------------
// Clerk-specific route config
// ---------------------------------------------------------------------------

const isPublicRoute = createRouteMatcher([
  "/",
  "/:locale",
  "/:locale/skills",
  "/:locale/glossary",
  "/:locale/pricing",
  "/terms-of-use",
  "/privacy-policy",
  "/:locale/design-system",
  "/:locale/blog",
  "/:locale/blog/posts/:slug",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
  "/api/slack/oauth/(.*)",
  "/slack/success",
  "/slack/failed",
  "/robots.txt",
  "/sitemap.xml",
]);

/**
 * Token prefix for self-signed sandbox/compose-job JWTs.
 * Clerk cannot parse these tokens because they are not standard JWTs
 * (they have a non-base64 prefix). We must strip the Authorization header
 * before the request reaches Clerk middleware, and restore it via a
 * forwarding header so route handlers can still authenticate.
 */
const SANDBOX_TOKEN_PREFIX = "vm0_sandbox_";

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
  const authHeader = request.headers.get("authorization");
  const hasSandboxToken =
    authHeader?.startsWith("Bearer " + SANDBOX_TOKEN_PREFIX) ?? false;

  if (hasSandboxToken) {
    // Clone the request without the Authorization header
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("x-vm0-authorization", authHeader!);

    const rewritten = new NextRequest(request.url, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
    });

    const response = await clerk(rewritten, event);

    // Restore the original Authorization header for the route handler
    if (response) {
      response.headers.set("x-middleware-request-authorization", authHeader!);
      response.headers.set(
        "x-middleware-request-x-vm0-authorization",
        authHeader!,
      );
    }
    return response;
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
