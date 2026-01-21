import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersSetDefaultContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { setModelProviderDefault } from "../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/logger";
import { NotFoundError } from "../../../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersSetDefaultContract, {
  /**
   * POST /api/model-providers/:type/set-default - Set model provider as default
   */
  setDefault: async ({ params }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("setting model provider as default", {
      userId,
      type: params.type,
    });

    try {
      const provider = await setModelProviderDefault(userId, params.type);

      return {
        status: 200 as const,
        body: {
          id: provider.id,
          type: provider.type,
          framework: provider.framework,
          credentialName: provider.credentialName,
          isDefault: provider.isDefault,
          createdAt: provider.createdAt.toISOString(),
          updatedAt: provider.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for model providers set-default API
 */
function errorHandler(err: unknown): TsRestResponse | void {
  // Handle ts-rest RequestValidationError
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    // Handle path params validation errors
    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        const message = issue.message;

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

const handler = createHandler(modelProvidersSetDefaultContract, router, {
  errorHandler,
});

export { handler as POST };
