import { NextRequest } from "next/server";
import { runLayers, corsLayer, i18nLayer } from "./middleware.layers";

/**
 * Single-user mode middleware.
 *
 * No authentication is performed - all requests are allowed through.
 * The shared layers still apply: CORS for API routes, i18n for pages.
 */
export default async function localMiddleware(request: NextRequest) {
  return runLayers(request, [corsLayer, i18nLayer]);
}
