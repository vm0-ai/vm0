import { clerkMiddleware } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import { locales, defaultLocale } from "./i18n";

// Routes that site handles locally (everything else proxies to web)
const SITE_LOCAL_ROUTES = [
  "/glossary",
  "/pricing",
  "/privacy-policy",
  "/terms-of-use",
  "/skills",
  "/blog",
];

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
 * - Static files and Next.js internals
 */
function isLocalRoute(pathname: string): boolean {
  // Root path
  if (pathname === "/") return true;

  // Static files and Next.js internals
  if (
    pathname.startsWith("/_next/") ||
    pathname.includes("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(pathname)
  ) {
    return true;
  }

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

  // Non-localized site routes (e.g., /privacy-policy, /terms-of-use)
  return SITE_LOCAL_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );
}

export default clerkMiddleware(async (_auth, request) => {
  const { pathname, search } = request.nextUrl;

  // Check if route should be handled locally by site
  if (isLocalRoute(pathname)) {
    // Skip i18n for static files
    if (
      pathname.startsWith("/_next/") ||
      pathname.includes("/assets/") ||
      /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(pathname)
    ) {
      return;
    }

    // Apply i18n middleware for site's local content routes
    return intlMiddleware(request);
  }

  // Proxy everything else to web app
  const webUrl = process.env.WEB_APP_URL;
  if (webUrl) {
    return NextResponse.rewrite(new URL(pathname + search, webUrl));
  }

  // Fallback: if no WEB_APP_URL, let Next.js handle (will 404)
  return;
});

export const config = {
  // Match all routes for proxy handling
  matcher: ["/((?!_next|_vercel).*)", "/(api|v1)(.*)"],
};
