import { clerkMiddleware } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import { locales, defaultLocale } from "./i18n";

// Routes that site handles locally (everything else proxies to web)
// Start empty - add routes here as pages are migrated from web to site
const SITE_LOCAL_ROUTES: string[] = [];

// Create the i18n middleware
const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
  localeDetection: true,
});

/**
 * Check if path should be handled locally by site app.
 * Returns true for:
 * - Root path `/`
 * - Locale roots `/:locale`
 * - Site local routes with or without locale prefix
 */
function isLocalRoute(pathname: string): boolean {
  // Root path
  if (pathname === "/") return true;

  // Check if path starts with a locale
  const pathParts = pathname.split("/").filter(Boolean);
  const firstPart = pathParts[0];
  const isLocalePrefix = locales.includes(
    firstPart as (typeof locales)[number],
  );

  if (isLocalePrefix) {
    // Locale root (e.g., /en, /ja)
    if (pathParts.length === 1) return true;

    // Check if rest of path matches a site local route
    const restOfPath = "/" + pathParts.slice(1).join("/");
    return SITE_LOCAL_ROUTES.some(
      (route) => restOfPath === route || restOfPath.startsWith(route + "/"),
    );
  }

  // Non-localized site routes
  return SITE_LOCAL_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );
}

export default clerkMiddleware(async (_auth, request) => {
  const { pathname, search } = request.nextUrl;

  // Check if route should be handled locally by site
  if (isLocalRoute(pathname)) {
    // Apply i18n middleware for site's local content routes
    return intlMiddleware(request);
  }

  // Proxy everything else to web app (including /_next/static/*)
  const webUrl = process.env.WEB_APP_URL;
  if (webUrl) {
    return NextResponse.rewrite(new URL(pathname + search, webUrl));
  }

  // Fallback: if no WEB_APP_URL, let Next.js handle (will 404)
  return;
});

export const config = {
  // Match ALL routes including _next/static for full proxy
  matcher: ["/(.*)", "/_next/static/:path*"],
};
