import { NextFetchEvent, NextRequest } from "next/server";
import clerkMiddleware from "./middleware.clerk";
import localMiddleware from "./middleware.local";

export { config } from "./middleware.config";

const isSelfHosted = process.env.SELF_HOSTED === "true";

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  if (isSelfHosted) {
    return localMiddleware(request);
  }

  return clerkMiddleware(request, event);
}
