import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { handleCors } from "./middleware.cors";
import { locales, defaultLocale } from "./i18n";

const isPublicRoute = createRouteMatcher([
  "/",
  "/:locale",
  "/:locale/skills",
  "/:locale/glossary",
  "/:locale/pricing",
  "/:locale/terms-of-use",
  "/:locale/privacy-policy",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
  "/api/slack/oauth/(.*)", // Slack OAuth endpoints (install, callback)
  "/slack/success", // Slack success page (shows result after OAuth)
  "/slack/failed", // Slack failed page (shows error after OAuth)
  "/robots.txt",
  "/sitemap.xml",
]);

// Create the i18n middleware
const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
  localeDetection: true,
});

export default clerkMiddleware(async (auth, request: NextRequest) => {
  // Skip i18n for API routes (including /v1), static files, CLI auth, Slack pages, sign-in, sign-up, and Next.js internals
  if (
    request.nextUrl.pathname.startsWith("/api/") ||
    request.nextUrl.pathname.startsWith("/v1/") ||
    request.nextUrl.pathname.startsWith("/_next/") ||
    request.nextUrl.pathname.startsWith("/cli-auth") ||
    request.nextUrl.pathname.startsWith("/slack/") ||
    request.nextUrl.pathname.startsWith("/sign-in") ||
    request.nextUrl.pathname.startsWith("/sign-up") ||
    request.nextUrl.pathname.includes("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(
      request.nextUrl.pathname,
    )
  ) {
    if (
      request.nextUrl.pathname.startsWith("/api/") ||
      request.nextUrl.pathname.startsWith("/v1/")
    ) {
      // Check if this might be a CLI token request BEFORE handling CORS
      const authHeader = request.headers.get("Authorization");
      const hasCliToken = authHeader && authHeader.includes("vm0_live_");

      // Skip Clerk auth for CLI token requests - will be handled at API route level
      if (hasCliToken) {
        return handleCors(request);
      }

      // Handle CORS for API routes
      return handleCors(request);
    }

    // Handle Clerk auth for CLI auth pages (requires login)
    if (request.nextUrl.pathname.startsWith("/cli-auth")) {
      await auth.protect();
    }

    // Handle Clerk auth for Slack link page (requires login)
    if (request.nextUrl.pathname.startsWith("/slack/link")) {
      await auth.protect();
    }

    // Return undefined to continue with default Next.js handling
    return undefined;
  }

  // Apply i18n middleware for non-API routes
  const response = intlMiddleware(request);

  // For non-CLI token requests, use regular Clerk authentication
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  return response;
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
