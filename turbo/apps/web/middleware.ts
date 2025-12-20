import { NextRequest, NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { handleCors } from "./middleware.cors";
import { isCommunityEdition } from "./src/lib/edition";

const isPublicRoute = createRouteMatcher([
  "/",
  "/cookbooks",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
  "/robots.txt",
  "/sitemap.xml",
]);

/**
 * Community Edition middleware - CORS only, no auth
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

  return NextResponse.next();
}

/**
 * Cloud Edition middleware - Clerk auth with CLI token bypass
 */
function cloudMiddleware(request: NextRequest) {
  return clerkMiddleware(async (auth, req) => {
    // Check if this might be a CLI token request BEFORE handling CORS
    const authHeader = req.headers.get("Authorization");
    const hasCliToken = authHeader && authHeader.includes("vm0_live_");

    // Skip Clerk auth for CLI token requests - will be handled at API route level
    if (hasCliToken) {
      // Still need to handle CORS for CLI requests
      if (req.nextUrl.pathname.startsWith("/api/")) {
        return handleCors(req);
      }
      return;
    }

    // Handle CORS for API routes
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return handleCors(req);
    }

    // For non-CLI token requests, use regular Clerk authentication
    if (!isPublicRoute(req)) {
      await auth.protect();
    }
  })(request, {} as never);
}

export default function middleware(request: NextRequest) {
  if (isCommunityEdition()) {
    return communityMiddleware(request);
  }
  return cloudMiddleware(request);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
