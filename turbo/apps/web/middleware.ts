import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { handleCors } from "./middleware.cors";
import { locales, defaultLocale } from "./i18n";

const isPublicRoute = createRouteMatcher([
  "/",
  "/:locale",
  "/:locale/skills",
  "/:locale/terms-of-use",
  "/:locale/privacy-policy",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
  "/robots.txt",
  "/sitemap.xml",
]);

// Custom locale detection functions
function getLocaleFromUrl(pathname: string): string | null {
  const segments = pathname.split('/');
  const potentialLocale = segments[1] ?? '';
  return locales.includes(potentialLocale as any) ? potentialLocale : null;
}

function getLocaleFromCookie(request: NextRequest): string | null {
  const cookieValue = request.cookies.get('LOCALE')?.value;
  return cookieValue ?? null;
}

function getLocaleFromHeader(request: NextRequest): string {
  const acceptLanguage = request.headers.get('accept-language');
  if (!acceptLanguage) return defaultLocale;

  // Parse Accept-Language header (simplified version)
  const parts = acceptLanguage.split(',')[0]?.split('-');
  const browserLang = parts?.[0] ?? defaultLocale;
  return locales.includes(browserLang as any) ? browserLang : defaultLocale;
}

export default clerkMiddleware(async (auth, request: NextRequest) => {
  // Skip i18n for API routes (including /v1), static files, CLI auth, sign-up, and Next.js internals
  if (
    request.nextUrl.pathname.startsWith("/api/") ||
    request.nextUrl.pathname.startsWith("/v1/") ||
    request.nextUrl.pathname.startsWith("/_next/") ||
    request.nextUrl.pathname.startsWith("/cli-auth") ||
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

    return;
  }

  // Apply custom locale detection for non-API routes
  const { pathname } = request.nextUrl;

  // Detect locale with priority: URL > Cookie > Accept-Language > Default
  const urlLocale = getLocaleFromUrl(pathname);
  const cookieLocale = getLocaleFromCookie(request);
  const headerLocale = getLocaleFromHeader(request);

  const detectedLocale = urlLocale || cookieLocale || headerLocale || defaultLocale;

  // If URL doesn't have locale, redirect to include it
  if (!urlLocale) {
    const newUrl = new URL(`/${detectedLocale}${pathname}`, request.url);
    const response = NextResponse.redirect(newUrl);
    response.cookies.set('LOCALE', detectedLocale, { maxAge: 60 * 60 * 24 * 365 });

    // For non-CLI token requests, use regular Clerk authentication
    if (!isPublicRoute(request)) {
      await auth.protect();
    }

    return response;
  }

  // Set cookie if locale detected from URL
  const response = NextResponse.next();
  response.cookies.set('LOCALE', urlLocale, { maxAge: 60 * 60 * 24 * 365 });

  // For non-CLI token requests, use regular Clerk authentication
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  return response;
});

export const config = {
  matcher: [
    "/((?!_next|_vercel|assets|.*\\..*|api|v1).*)",
    "/(api|v1|trpc)(.*)",
  ],
};
