// oxlint-disable-next-line no-restricted-imports -- this file is the api's
// CORS owner and wraps hono's cors helper into a single middleware.
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

import { env } from "./env";

// Mirrors apps/web/proxy.cors.ts. Now that /api/zero/* is served by hono
// directly (not proxied to Next), responses from registered routes need their
// own CORS headers — the web proxy fallthrough is no longer in the request
// path for migrated endpoints.
const STATIC_ALLOWED_ORIGINS: readonly string[] = [
  "https://www.vm0.ai",
  "https://vm0.ai",
];

function getAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  const normalizedOrigin = url.origin;
  const { hostname, protocol } = url;

  if (STATIC_ALLOWED_ORIGINS.includes(normalizedOrigin)) {
    return normalizedOrigin;
  }

  const deployEnv = env("ENV");

  const allowHttpLocalhost =
    deployEnv === "development" &&
    protocol === "http:" &&
    hostname === "localhost";
  if (!allowHttpLocalhost && protocol !== "https:") return null;

  if (hostname.endsWith(".vm0.ai")) return normalizedOrigin;

  if (deployEnv === "preview" && hostname.endsWith(".vm6.ai")) {
    return normalizedOrigin;
  }

  if (deployEnv === "development") {
    if (hostname === "localhost") return normalizedOrigin;
    if (hostname.endsWith(".vm6.ai")) return normalizedOrigin;
    if (hostname.endsWith(".vm7.ai")) return normalizedOrigin;
  }

  return null;
}

export const corsMiddleware: MiddlewareHandler = cors({
  origin: (origin) => getAllowedOrigin(origin),
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: [
    "X-CSRF-Token",
    "X-Requested-With",
    "Accept",
    "Accept-Version",
    "Content-Length",
    "Content-MD5",
    "Content-Type",
    "Date",
    "X-Api-Version",
    "Authorization",
    "Range",
  ],
  maxAge: 86400,
});
