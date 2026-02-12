import { NextFetchEvent, NextRequest } from "next/server";
import { env } from "./src/env";
import clerkMiddleware from "./middleware.clerk";
import localMiddleware from "./middleware.local";

export { config } from "./middleware.config";

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  const useLocalAuth = !env().NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (useLocalAuth) {
    return localMiddleware(request);
  }

  return clerkMiddleware(request, event);
}
