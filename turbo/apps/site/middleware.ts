import { clerkMiddleware } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import { locales, defaultLocale } from "./i18n";

// Routes to proxy to web app
const PROXY_PREFIXES = [
  "/api/",
  "/v1/",
  "/sign-in",
  "/sign-up",
  "/cli-auth",
  "/slack/",
];

// Create the i18n middleware
const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
  localeDetection: true,
});

export default clerkMiddleware(async (_auth, request) => {
  const { pathname, search } = request.nextUrl;

  // Check if route should be proxied to web app
  const shouldProxy = PROXY_PREFIXES.some(
    (prefix) =>
      pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix),
  );

  if (shouldProxy) {
    const webUrl = process.env.WEB_APP_URL;
    if (webUrl) {
      return NextResponse.rewrite(new URL(pathname + search, webUrl));
    }
  }

  // Skip i18n for static files and Next.js internals
  if (
    pathname.startsWith("/_next/") ||
    pathname.includes("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(pathname)
  ) {
    return;
  }

  // Apply i18n middleware for all content routes (all routes are public)
  return intlMiddleware(request);
});

export const config = {
  // Add api and v1 to matcher for proxy handling
  matcher: ["/((?!_next|_vercel|assets|.*\\..*).*)", "/(api|v1)(.*)"],
};
