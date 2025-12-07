import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import { UnauthorizedError } from "../../../../../src/lib/errors";

// NOTE: This is a minimal mock implementation that does NOT import image-service

/**
 * GET /api/images/[buildId]/status
 * Get build status with logs
 * MOCK: Returns ready status
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ buildId: string }> },
) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { buildId } = await params;

    // MOCK: Return ready status
    return successResponse({
      buildId,
      status: "ready",
      logs: ["[MOCK] Build completed"],
      logsOffset: 1,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
