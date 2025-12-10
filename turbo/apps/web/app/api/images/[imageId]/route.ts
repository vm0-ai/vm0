import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { imagesByIdContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { deleteImage } from "../../../../src/lib/image/image-service";
import { NotFoundError, ForbiddenError } from "../../../../src/lib/errors";

const router = tsr.router(imagesByIdContract, {
  delete: async ({ params }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { imageId } = params;

    try {
      await deleteImage(userId, imageId);
      return { status: 200 as const, body: { deleted: true } };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          status: 404 as const,
          body: {
            error: { message: error.message, code: "NOT_FOUND" },
          },
        };
      }
      if (error instanceof ForbiddenError) {
        return {
          status: 403 as const,
          body: {
            error: { message: error.message, code: "FORBIDDEN" },
          },
        };
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
          { error: { message: "Missing imageId", code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  // Let other errors propagate
  return undefined;
}

const handler = createNextHandler(imagesByIdContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as DELETE };
