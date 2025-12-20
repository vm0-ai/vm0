import { NextRequest, NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { handleCors } from "./middleware.cors";
import { isCommunityEdition } from "./src/lib/edition";
import { locales, defaultLocale } from "./i18n";

const isPublicRoute = createRouteMatcher([
  "/",
  "/:locale",
  "/:locale/cookbooks",
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

/**
 * Check if request should skip i18n processing
 */
function shouldSkipI18n(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/cli-auth") ||
    pathname.includes("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(pathname)
  );
}

/**
 * Community Edition middleware - i18n support, CORS, no Clerk auth
 * Redirects auth pages since they're not needed
 */
function communityMiddleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Redirect auth pages to home (no login needed in Community Edition)
  if (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Handle CORS for API routes
  if (pathname.startsWith("/api/")) {
    return handleCors(request);
  }

  // Skip i18n for static files and internals
  if (shouldSkipI18n(pathname)) {
    return NextResponse.next();
  }

  // Apply i18n middleware for non-API routes
  return intlMiddleware(request);
}

/**
 * Cloud Edition middleware - Clerk auth with CLI token bypass and i18n support
 */
function cloudMiddleware(request: NextRequest) {
  return clerkMiddleware(async (auth, req) => {
    const { pathname } = req.nextUrl;

    // Skip i18n for API routes, static files, CLI auth, and Next.js internals
    if (shouldSkipI18n(pathname)) {
      if (pathname.startsWith("/api/")) {
        // Check if this might be a CLI token request BEFORE handling CORS
        const authHeader = req.headers.get("Authorization");
        const hasCliToken = authHeader && authHeader.includes("vm0_live_");

        // Skip Clerk auth for CLI token requests - will be handled at API route level
        if (hasCliToken) {
          return handleCors(req);
        }

        // Handle CORS for API routes
        return handleCors(req);
      }

      // Handle Clerk auth for CLI auth page
      if (pathname.startsWith("/cli-auth")) {
        if (!isPublicRoute(req)) {
          await auth.protect();
        }
      }

      return;
    }

    // Apply i18n middleware for non-API routes
    const response = intlMiddleware(req);

    // For non-CLI token requests, use regular Clerk authentication
    if (!isPublicRoute(req)) {
      await auth.protect();
    }

    return response;
  })(request, {} as never);
}

export default function middleware(request: NextRequest) {
  if (isCommunityEdition()) {
    return communityMiddleware(request);
  }
  return cloudMiddleware(request);
}

export const config = {
  matcher: ["/((?!_next|_vercel|assets|.*\\..*|api).*)", "/(api|trpc)(.*)"],
};
