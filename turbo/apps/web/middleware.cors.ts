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
function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;

  // Check exact match against allowlist
  if (allowedOrigins.includes(origin)) return true;

  const url = new URL(origin);
  const hostname = url.hostname;

  // Always allow *.vm0.ai subdomains
  if (hostname.endsWith(".vm0.ai")) return true;

  // Preview environment: additionally allow *.vercel.app
  if (env().VERCEL_ENV === "preview") {
    if (hostname.endsWith(".vercel.app")) return true;
  }

  // Development environment: additionally allow localhost and *.vercel.app
  if (env().NODE_ENV === "development") {
    if (hostname === "localhost") return true;
    if (hostname.endsWith(".vercel.app")) return true;
    if (hostname.endsWith(".vm7.ai")) return true;
  }

  return false;
}

export function handleCors(request: NextRequest) {
  const origin = request.headers.get("origin");
  const response = NextResponse.next();

  // Only set CORS headers if there's an origin (browser requests)
  if (origin && isOriginAllowed(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      response.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      response.headers.set(
        "Access-Control-Allow-Headers",
        "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization",
      );
      response.headers.set("Access-Control-Max-Age", "86400");
      return new NextResponse(null, { status: 200, headers: response.headers });
    }
  }

  return response;
}
