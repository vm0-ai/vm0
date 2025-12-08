import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../../src/lib/api-response";
import {
  BadRequestError,
  UnauthorizedError,
  NotFoundError,
} from "../../../../../../src/lib/errors";
import {
  getBuildStatus,
  getImageById,
} from "../../../../../../src/lib/image/image-service";

interface BuildStatusResponse {
  status: "building" | "ready" | "error";
  logs: string[];
  logsOffset: number;
  error?: string;
}

/**
 * GET /api/images/:imageId/builds/:buildId
 * Query build status with incremental logs
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ imageId: string; buildId: string }> },
) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { imageId, buildId } = await params;

    if (!imageId) {
      throw new BadRequestError("Missing imageId");
    }

    if (!buildId) {
      throw new BadRequestError("Missing buildId");
    }

    // Get logsOffset from query parameter
    const { searchParams } = new URL(request.url);
    const logsOffsetParam = searchParams.get("logsOffset");
    const logsOffset = logsOffsetParam ? parseInt(logsOffsetParam, 10) : 0;

    if (isNaN(logsOffset) || logsOffset < 0) {
      throw new BadRequestError("Invalid logsOffset parameter");
    }

    // Get image from database by imageId
    const image = await getImageById(imageId);

    if (!image) {
      throw new NotFoundError(`Image not found: ${imageId}`);
    }

    // Verify ownership
    if (image.userId !== userId) {
      throw new UnauthorizedError("You don't have access to this image");
    }

    // Verify buildId matches
    if (image.e2bBuildId !== buildId) {
      throw new NotFoundError(`Build not found: ${buildId}`);
    }

    // Get build status from E2B
    const result = await getBuildStatus(
      buildId,
      image.e2bTemplateId ?? "",
      logsOffset,
    );

    const response: BuildStatusResponse = {
      status: result.status,
      logs: result.logs,
      logsOffset: result.logsOffset,
      error: result.error,
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
