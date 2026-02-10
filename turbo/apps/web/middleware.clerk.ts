import {
  clerkMiddleware,
  createRouteMatcher,
  type ClerkMiddlewareAuth,
} from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import {
  runLayers,
  corsLayer,
  i18nLayer,
  MiddlewareLayer,
  isProtectedSkipRoute,
} from "./middleware.layers";

// ---------------------------------------------------------------------------
// Clerk-specific route config
// ---------------------------------------------------------------------------

const isPublicRoute = createRouteMatcher([
  "/",
  "/:locale",
  "/:locale/skills",
  "/:locale/glossary",
  "/:locale/pricing",
  "/:locale/terms-of-use",
  "/:locale/privacy-policy",
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

// ---------------------------------------------------------------------------
// Clerk auth layer
// ---------------------------------------------------------------------------

/**
 * Captured Clerk `auth` handle. Set by the clerkMiddleware wrapper before
 * `runLayers` is invoked, so authLayer can call `auth.protect()`.
 */
let _clerkAuth: ClerkMiddlewareAuth;

const clerkAuthLayer: MiddlewareLayer = async (ctx) => {
  if (ctx.routeKind === "skip") {
    if (isProtectedSkipRoute(ctx.request.nextUrl.pathname)) {
      await _clerkAuth.protect();
    }
    return null;
  }

  // Page routes: protect non-public routes
  if (ctx.routeKind === "page") {
    if (!isPublicRoute(ctx.request)) {
      await _clerkAuth.protect();
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Clerk middleware
//
// clerkMiddleware wraps the whole handler. Inside its callback we capture
// the `auth` handle and delegate to `runLayers` for uniform layer ordering.
// ---------------------------------------------------------------------------

export default clerkMiddleware(async (auth, request: NextRequest) => {
  _clerkAuth = auth;

  return runLayers(request, [corsLayer, clerkAuthLayer, i18nLayer]);
});
