import { NextResponse } from "next/server";
import { ApiError } from "./errors";

/**
 * Standard success response
 */
export function successResponse<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * Standard error response
 */
export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: {
          message: error.message,
          code: error.code,
        },
      },
      { status: error.statusCode },
    );
  }

  // Unexpected error
  console.error("Unexpected error:", error);
  return NextResponse.json(
    {
      error: {
        message: "Internal server error",
        code: "INTERNAL_SERVER_ERROR",
      },
    },
    { status: 500 },
  );
}
