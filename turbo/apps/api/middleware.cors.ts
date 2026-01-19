import { NextRequest, NextResponse } from "next/server";

// Define allowed origins
const allowedOrigins = [
  // Production domains
  "https://www.vm0.ai",
  "https://vm0.ai",
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;

  // Check exact match
  if (allowedOrigins.includes(origin)) return true;

  // Allow any *.vm0.ai subdomain
  const url = new URL(origin);
  return url.hostname.endsWith(".vm0.ai");
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
