import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import { BadRequestError, UnauthorizedError } from "../../../../src/lib/errors";
import { deleteImage } from "../../../../src/lib/image/image-service";

/**
 * DELETE /api/images/:imageId
 * Delete an image by ID
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ imageId: string }> },
) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { imageId } = await params;

    if (!imageId) {
      throw new BadRequestError("Missing imageId");
    }

    // Delete the image
    await deleteImage(userId, imageId);

    return successResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
