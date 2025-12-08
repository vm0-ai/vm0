import { NextRequest } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { successResponse, errorResponse } from "../../../src/lib/api-response";
import { BadRequestError, UnauthorizedError } from "../../../src/lib/errors";
import {
  buildImage,
  listImages,
  deleteImageByAlias,
  getImageByAlias,
  generateE2bAlias,
  tryDeleteE2bTemplateByAlias,
} from "../../../src/lib/image/image-service";

interface CreateImageRequest {
  dockerfile: string;
  alias: string;
  deleteExisting?: boolean;
}

interface CreateImageResponse {
  buildId: string;
  imageId: string;
  alias: string;
}

/**
 * GET /api/images
 * List all images for the authenticated user
 */
export async function GET() {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // List user's images
    const imageList = await listImages(userId);

    return successResponse({ images: imageList });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/images
 * Create an image build task from a Dockerfile
 */
export async function POST(request: NextRequest) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse request body
    const body: CreateImageRequest = await request.json();

    // Validate request
    const { dockerfile, alias, deleteExisting } = body;

    if (!dockerfile) {
      throw new BadRequestError("Missing dockerfile");
    }

    if (!alias) {
      throw new BadRequestError("Missing alias");
    }

    // Validate alias format: 3-64 chars, alphanumeric and hyphens, start/end with alphanumeric
    const aliasRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;
    if (!aliasRegex.test(alias)) {
      throw new BadRequestError(
        "Invalid alias format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
      );
    }

    // Prevent user from creating templates with system prefix
    if (alias.startsWith("vm0-")) {
      throw new BadRequestError(
        'Invalid alias. User images cannot start with "vm0-" prefix (reserved for system templates).',
      );
    }

    // Delete existing image if requested
    if (deleteExisting) {
      // First try to delete from our database
      const existingImage = await getImageByAlias(userId, alias);
      if (existingImage) {
        await deleteImageByAlias(userId, alias);
      }

      // Also try to delete from E2B directly in case database record is stale
      // This handles the case where DB was cleaned up but E2B template still exists
      const e2bAlias = generateE2bAlias(userId, alias);
      await tryDeleteE2bTemplateByAlias(e2bAlias);
    }

    // Start image build
    const result = await buildImage(userId, dockerfile, alias);

    const response: CreateImageResponse = {
      buildId: result.buildId,
      imageId: result.imageId,
      alias: result.alias,
    };

    return successResponse(response, 202); // 202 Accepted for async operation
  } catch (error) {
    return errorResponse(error);
  }
}
