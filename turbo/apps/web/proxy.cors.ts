import { NextRequest, NextResponse } from "next/server";

import { env } from "./src/env";

// Define allowed origins
const allowedOrigins = [
  // Production domains
  "https://www.vm0.ai",
  "https://vm0.ai",
];

/**
 * Environment-aware origin validation
 *
 * Security Model:
 * - Production: Strict *.vm0.ai only
 * - Preview: Allows *.vercel.app + production domains (mitigated by Clerk auth)
 * - Development: Allows localhost + preview + production
 *
 * @param origin - The origin header from the request
 * @returns true if origin is allowed for the current environment
 */
function getAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;

  try {
    const url = new URL(origin);
    const normalizedOrigin = url.origin;
    const { hostname, protocol } = url;

    // Check exact match against allowlist
    if (allowedOrigins.includes(normalizedOrigin)) return normalizedOrigin;

    // Only localhost is allowed over http, and only in development.
    const allowHttpLocalhost =
      env().NODE_ENV === "development" &&
      protocol === "http:" &&
      hostname === "localhost";
    if (!allowHttpLocalhost && protocol !== "https:") return null;

    // Always allow *.vm0.ai subdomains
    if (hostname.endsWith(".vm0.ai")) return normalizedOrigin;

    // Preview environment: additionally allow *.vm6.ai
    if (env().VERCEL_ENV === "preview" && hostname.endsWith(".vm6.ai")) {
      return normalizedOrigin;
    }

    // Development environment: additionally allow localhost, *.vm6.ai, *.vm7.ai
    if (env().NODE_ENV === "development") {
      if (hostname === "localhost") return normalizedOrigin;
      if (hostname.endsWith(".vm6.ai")) return normalizedOrigin;
      if (hostname.endsWith(".vm7.ai")) return normalizedOrigin;
    }
  } catch {
    return null;
  }

  return null;
}

export function applyCorsHeaders(
  request: NextRequest,
  response: NextResponse,
): NextResponse {
  const allowedOrigin = getAllowedOrigin(request.headers.get("origin"));
  if (allowedOrigin) {
    setAllowedOriginHeaders(response, allowedOrigin);
  }
  return response;
}

function setAllowedOriginHeaders(
  response: NextResponse,
  allowedOrigin: string,
): void {
  // allowedOrigin comes only from getAllowedOrigin's exact allowlist or
  // environment-scoped subdomain gates; CORS cannot use "*" with credentials.
  // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
  response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  response.headers.set("Access-Control-Allow-Credentials", "true");
  response.headers.set("Vary", "Origin");
}

export function handleCors(request: NextRequest) {
  const allowedOrigin = getAllowedOrigin(request.headers.get("origin"));

  // Only set CORS headers if there's an origin (browser requests)
  if (allowedOrigin) {
    // Handle preflight requests — return a fresh response without
    // x-middleware-next so Next.js does NOT forward to the route handler.
    if (request.method === "OPTIONS") {
      const response = new NextResponse(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Methods":
            "GET, POST, PUT, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers":
            "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, Range",
          "Access-Control-Max-Age": "86400",
        },
      });
      setAllowedOriginHeaders(response, allowedOrigin);
      return response;
    }

    return applyCorsHeaders(request, NextResponse.next());
  }

  return NextResponse.next();
}
