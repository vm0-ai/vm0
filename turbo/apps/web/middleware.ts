import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/hello(.*)",
  "/api/cli/auth/device",
  "/api/cli/auth/token",
  "/api/agent/configs(.*)",
  "/api/agent/runs(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  const authHeader = request.headers.get("Authorization");

  // Skip Clerk auth for CLI token requests
  if (authHeader?.includes("vm0_live_")) {
    return NextResponse.next();
  }

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
