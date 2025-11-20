import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { handleCors } from "./middleware.cors";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/hello(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
]);

export default clerkMiddleware(async (auth, request) => {
  // Check if this might be a CLI token request BEFORE handling CORS
  const authHeader = request.headers.get("Authorization");
  const hasCliToken = authHeader && authHeader.includes("vm0_live_");

  // Skip Clerk auth for CLI token requests - will be handled at API route level
  if (hasCliToken) {
    // Still need to handle CORS for CLI requests
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return handleCors(request);
    }
    return;
  }

  // Handle CORS for API routes
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return handleCors(request);
  }

  // For non-CLI token requests, use regular Clerk authentication
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
