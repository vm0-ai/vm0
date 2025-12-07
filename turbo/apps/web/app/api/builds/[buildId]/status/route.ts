import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import { UnauthorizedError } from "../../../../../src/lib/errors";

/**
 * GET /api/builds/[buildId]/status
 * Get build status with logs - MOCK
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ buildId: string }> },
) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { buildId } = await params;

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
