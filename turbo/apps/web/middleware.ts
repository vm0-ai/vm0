import { NextFetchEvent, NextRequest } from "next/server";
import { isSelfHosted } from "./src/env";
import clerkMiddleware from "./middleware.clerk";
import localMiddleware from "./middleware.local";

export { config } from "./middleware.config";

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  if (isSelfHosted()) {
    return localMiddleware(request);
  }

  return clerkMiddleware(request, event);
}
