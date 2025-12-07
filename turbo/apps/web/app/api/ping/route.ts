import { NextResponse } from "next/server";

/**
 * GET /api/ping
 * Minimal endpoint with no DB imports to test basic API route functionality
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "pong",
    timestamp: new Date().toISOString(),
    environment: process.env.VERCEL ? "vercel" : "local",
  });
}
