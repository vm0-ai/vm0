import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { imagesByIdContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { deleteImage } from "../../../../src/lib/image/image-service";
import { NotFoundError, ForbiddenError } from "../../../../src/lib/errors";

const router = tsr.router(imagesByIdContract, {
  delete: async ({ params }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { imageId } = params;

    try {
      await deleteImage(userId, imageId);
      return { status: 200 as const, body: { deleted: true } };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      if (error instanceof ForbiddenError) {
        return createErrorResponse("FORBIDDEN", error.message);
      }
      throw error;
    }
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  // Handle ts-rest RequestValidationError
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          {
            error: {
              message: "Missing imageId",
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

const handler = createHandler(imagesByIdContract, router, {
  errorHandler,
});

export { handler as DELETE };
