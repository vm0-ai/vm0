import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
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

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export default clerkMiddleware(async (auth, request: NextRequest) => {
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
