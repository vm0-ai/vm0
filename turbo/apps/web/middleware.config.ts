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
