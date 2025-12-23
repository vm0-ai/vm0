import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { handleCors } from "./middleware.cors";
import { locales, defaultLocale } from "./i18n";

const isPublicRoute = createRouteMatcher([
  "/",
  "/:locale",
  "/:locale/cookbooks",
  "/:locale/skills",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
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
  // Skip i18n for API routes, static files, CLI auth, sign-up, and Next.js internals
  if (
    request.nextUrl.pathname.startsWith("/api/") ||
    request.nextUrl.pathname.startsWith("/_next/") ||
    request.nextUrl.pathname.startsWith("/cli-auth") ||
    request.nextUrl.pathname.startsWith("/sign-up") ||
    request.nextUrl.pathname.includes("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(
      request.nextUrl.pathname,
    )
  ) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
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

    return;
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
  matcher: ["/((?!_next|_vercel|assets|.*\\..*|api).*)", "/(api|trpc)(.*)"],
};
