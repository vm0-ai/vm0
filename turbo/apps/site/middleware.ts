import { clerkMiddleware } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import { locales, defaultLocale } from "./i18n";

// Routes that site handles locally (everything else proxies to web)
// Add routes here as pages are migrated from web to site
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

  // Skip for static files
  if (
    pathname.startsWith("/_next/") ||
    pathname.includes("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(pathname)
  ) {
    return;
  }

  // Check if route should be handled locally by site
  if (isLocalRoute(pathname)) {
    return intlMiddleware(request);
  }

  // Proxy everything else to web app
  const webUrl = process.env.WEB_APP_URL;
  if (webUrl) {
    return NextResponse.rewrite(new URL(pathname + search, webUrl));
  }

  // Fallback: apply i18n middleware (will 404 if page doesn't exist)
  return intlMiddleware(request);
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
