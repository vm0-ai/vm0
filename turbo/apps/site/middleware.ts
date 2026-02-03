import { clerkMiddleware } from "@clerk/nextjs/server";
import createIntlMiddleware from "next-intl/middleware";
import { locales, defaultLocale } from "./i18n";

// Create the i18n middleware
const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
  localeDetection: true,
});

export default clerkMiddleware(async (_auth, request) => {
  // Skip i18n for static files and Next.js internals
  if (
    request.nextUrl.pathname.startsWith("/_next/") ||
    request.nextUrl.pathname.includes("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|eot)$/i.test(
      request.nextUrl.pathname,
    )
  ) {
    return;
  }

  // Apply i18n middleware for all content routes (all routes are public)
  return intlMiddleware(request);
});

export const config = {
  matcher: ["/((?!_next|_vercel|assets|.*\\..*|api|v1).*)"],
};
