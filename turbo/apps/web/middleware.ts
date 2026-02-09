import { NextFetchEvent, NextRequest } from "next/server";

export { config } from "./middleware.config";

const isSelfHosted = process.env.SELF_HOSTED === "true";

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  if (isSelfHosted) {
    const { default: handler } = await import("./middleware.local");
    return handler(request);
  }

  const { default: handler } = await import("./middleware.clerk");
  return handler(request, event);
}
