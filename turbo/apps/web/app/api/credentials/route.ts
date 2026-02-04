import { NextResponse } from "next/server";

/**
 * /api/credentials endpoint has been removed.
 * Users should upgrade their CLI and use /api/secrets instead.
 */

const errorResponse = () =>
  NextResponse.json(
    {
      error: {
        message:
          "This endpoint has been removed. Please upgrade your CLI and use /api/secrets instead.",
        code: "ENDPOINT_REMOVED",
      },
    },
    { status: 410 },
  );

export function GET() {
  return errorResponse();
}

export function PUT() {
  return errorResponse();
}
