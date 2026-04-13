import createIntlMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { locales, defaultLocale } from "./i18n";

const intlMiddleware = createIntlMiddleware({
  locales: locales as unknown as string[],
  defaultLocale,
  localePrefix: "always",
});

export default function middleware(request: NextRequest) {
  const response = intlMiddleware(request);
  // Expose pathname to Server Components (used for <html lang> and hreflang)
  response.headers.set("x-pathname", request.nextUrl.pathname);
  return response;
}

export const config = {
  // Run on all routes except API, _next internals, static files, and
  // non-localized legal pages (privacy-policy, terms-of-use).
  matcher: ["/((?!api|_next|_vercel|privacy-policy|terms-of-use|.*\\..*).*)"],
};
