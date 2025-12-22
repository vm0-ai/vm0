import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { imagesMainContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  buildImage,
  listImages,
  deleteImageByAlias,
  getImageByAlias,
  generateE2bAlias,
  tryDeleteE2bTemplateByAlias,
} from "../../../src/lib/image/image-service";

const router = tsr.router(imagesMainContract, {
  list: async () => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const imageList = await listImages(userId);
    return { status: 200 as const, body: { images: imageList } };
  },

  create: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { dockerfile, alias, deleteExisting } = body;

    // Delete existing image if requested
    if (deleteExisting) {
      // First try to delete from our database
      const existingImage = await getImageByAlias(userId, alias);
      if (existingImage) {
        await deleteImageByAlias(userId, alias);
      }

      // Also try to delete from E2B directly in case database record is stale
      const e2bAlias = generateE2bAlias(userId, alias);
      await tryDeleteE2bTemplateByAlias(e2bAlias);
    }

    // Start image build
    const result = await buildImage(userId, dockerfile, alias);

    return {
      status: 202 as const,
      body: {
        buildId: result.buildId,
        imageId: result.imageId,
        alias: result.alias,
        versionId: result.versionId,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  // Handle ts-rest RequestValidationError
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    // Handle body validation errors
    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const field = issue.path[0];
        let message = issue.message;

        // Map error messages to match existing API format
        if (field === "dockerfile") {
          message = "Missing dockerfile";
        } else if (field === "alias") {
          if (message.includes("vm0-")) {
            message =
              'Invalid alias. User images cannot start with "vm0-" prefix (reserved for system templates).';
          } else {
            message =
              "Invalid alias format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.";
          }
        }

        return TsRestResponse.fromJson(
          { error: { message, code: ApiError.BAD_REQUEST.code } },
          { status: ApiError.BAD_REQUEST.status },
        );
      }
    }
  }

  // Let other errors propagate
  return undefined;
}

const handler = createNextHandler(imagesMainContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as GET, handler as POST };
