import { NextRequest } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { successResponse, errorResponse } from "../../../src/lib/api-response";
import { BadRequestError, UnauthorizedError } from "../../../src/lib/errors";

// NOTE: This is a minimal mock implementation that does NOT import image-service
// to test if the routes themselves cause the timeout issue

/**
 * GET /api/images
 * List all images for the authenticated user
 * MOCK: Returns empty array
 */
export async function GET() {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // MOCK: Return empty list
    return successResponse({ images: [] });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/images
 * Build a new image from Dockerfile content
 * MOCK: Returns fake build data
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const body = await request.json();
    const { dockerfile, alias } = body;

    // Basic validation
    if (!dockerfile) {
      throw new BadRequestError("Missing dockerfile content");
    }

    if (!alias) {
      throw new BadRequestError("Missing alias");
    }

    // MOCK: Return fake build data
    const mockBuildId = `mock-build-${Date.now()}`;
    return successResponse(
      {
        imageId: `mock-image-${Date.now()}`,
        buildId: mockBuildId,
        alias,
        e2bAlias: `user-${userId}-${alias}`,
      },
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
