import { NextRequest, NextResponse } from "next/server";
import {
  runLayers,
  corsLayer,
  i18nLayer,
  MiddlewareLayer,
} from "./middleware.layers";

/** Redirect auth pages to home since self-hosted mode has no login flow. */
const authRedirectLayer: MiddlewareLayer = (ctx) => {
  const { pathname } = ctx.request.nextUrl;
  if (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) {
    return NextResponse.redirect(new URL("/", ctx.request.url));
  }
  return null;
};

/**
 * Single-user mode middleware.
 *
 * No authentication is performed - all requests are allowed through.
 * The shared layers still apply: CORS for API routes, i18n for pages.
 * Auth pages redirect to home.
 */
export default async function localMiddleware(request: NextRequest) {
  return runLayers(request, [authRedirectLayer, corsLayer, i18nLayer]);
}
