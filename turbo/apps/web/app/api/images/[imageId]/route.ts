import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { errorResponse } from "../../../../src/lib/api-response";
import { UnauthorizedError, NotFoundError } from "../../../../src/lib/errors";

// NOTE: This is a minimal mock implementation that does NOT import image-service

/**
 * GET /api/images/[imageId]
 * Get image details
 * MOCK: Returns not found
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

    // MOCK: Always return not found since we don't have the DB operations
    throw new NotFoundError(`Image not found: ${imageId}`);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/images/[imageId]
 * Delete an image
 * MOCK: Returns not found
 */
export async function DELETE(
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

    // MOCK: Always return not found since we don't have the DB operations
    throw new NotFoundError(`Image not found: ${imageId}`);
  } catch (error) {
    return errorResponse(error);
  }
}
