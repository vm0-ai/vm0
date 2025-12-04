import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { handleCors } from "./middleware.cors";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/hello(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
  "/robots.txt",
  "/sitemap.xml",
]);

export default clerkMiddleware(async (auth, request) => {
  // Security: Always clear any user-spoofed x-vm0-debug-verified header
  // This header is set internally after verification, users cannot set it
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("x-vm0-debug-verified");

  // Check if this might be a CLI token request BEFORE handling CORS
  const authHeader = request.headers.get("Authorization");
  const hasCliToken = authHeader && authHeader.includes("vm0_live_");

  // Skip Clerk auth for CLI token requests - will be handled at API route level
  if (hasCliToken) {
    // Still need to handle CORS for CLI requests
    if (request.nextUrl.pathname.startsWith("/api/")) {
      const corsResponse = handleCors(request);
      // If CORS returned a response (preflight), return it
      if (corsResponse.status === 200 && request.method === "OPTIONS") {
        return corsResponse;
      }
      // Otherwise, pass through with cleaned headers
      return NextResponse.next({
        request: { headers: requestHeaders },
      });
    }
    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  }

  // Handle CORS for API routes
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const corsResponse = handleCors(request);
    // If CORS returned a response (preflight), return it
    if (corsResponse.status === 200 && request.method === "OPTIONS") {
      return corsResponse;
    }
    // Otherwise, pass through with cleaned headers
    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  }

  // For non-CLI token requests, use regular Clerk authentication
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  // Pass through with cleaned headers
  return NextResponse.next({
    request: { headers: requestHeaders },
  });
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
