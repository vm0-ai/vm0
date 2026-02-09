import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import {
  classifyRoute,
  isProtectedSkipRoute,
  intlMiddleware,
} from "./middleware.layers";
import { handleCors } from "./middleware.cors";

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
// Clerk middleware
//
// clerkMiddleware wraps the whole handler, so the onion model is implemented
// inside its callback. The shared layers (CORS, i18n) are called explicitly,
// while Clerk's `auth` object provides the auth layer.
// ---------------------------------------------------------------------------

export default clerkMiddleware(async (auth, request: NextRequest) => {
  const routeKind = classifyRoute(request.nextUrl.pathname);

  // Layer 1: API routes - CORS + optional CLI token bypass
  if (routeKind === "api") {
    return handleCors(request);
  }

  // Layer 2: Skip-i18n routes (static files, auth pages, etc.)
  if (routeKind === "skip") {
    if (isProtectedSkipRoute(request.nextUrl.pathname)) {
      await auth.protect();
    }
    return undefined;
  }

  // Layer 3: Page routes - i18n + Clerk auth
  const response = intlMiddleware(request);

  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  return response;
});
