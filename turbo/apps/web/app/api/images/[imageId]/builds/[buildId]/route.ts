import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { imageBuildsContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import {
  getBuildStatus,
  getImageById,
} from "../../../../../../src/lib/image/image-service";

const router = tsr.router(imageBuildsContract, {
  getStatus: async ({ params, query }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { imageId, buildId } = params;
    const logsOffset = query.logsOffset ?? 0;

    // Get image from database by imageId
    const image = await getImageById(imageId);

    if (!image) {
      return createErrorResponse("NOT_FOUND", `Image not found: ${imageId}`);
    }

    // Verify ownership
    if (image.userId !== userId) {
      return createErrorResponse(
        "UNAUTHORIZED",
        "You don't have access to this image",
      );
    }

    // Verify buildId matches
    if (image.e2bBuildId !== buildId) {
      return createErrorResponse("NOT_FOUND", `Build not found: ${buildId}`);
    }

    // Get build status from E2B
    const result = await getBuildStatus(
      buildId,
      image.e2bTemplateId ?? "",
      logsOffset,
    );

    return {
      status: 200 as const,
      body: {
        status: result.status,
        logs: result.logs,
        logsOffset: result.logsOffset,
        error: result.error,
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
    "pathParamsError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        const field = issue.path[0];
        const message =
          field === "imageId" ? "Missing imageId" : "Missing buildId";
        return TsRestResponse.fromJson(
          { error: { message, code: ApiError.BAD_REQUEST.code } },
          { status: ApiError.BAD_REQUEST.status },
        );
      }
    }

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          {
            error: {
              message: "Invalid logsOffset parameter",
              code: ApiError.BAD_REQUEST.code,
            },
          },
          { status: ApiError.BAD_REQUEST.status },
        );
      }
    }
  }

  // Let other errors propagate
  return undefined;
}

const handler = createHandler(imageBuildsContract, router, {
  errorHandler,
});

export { handler as GET };
