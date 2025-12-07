import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { errorResponse } from "../../../../src/lib/api-response";
import { UnauthorizedError, NotFoundError } from "../../../../src/lib/errors";

/**
 * GET /api/images/[imageId]
 * Get image details - MOCK
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> },
) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { imageId } = await params;
    throw new NotFoundError(`Image not found: ${imageId}`);
  } catch (error) {
    return errorResponse(error);
  }
}
