import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersCheckContract,
  createErrorResponse,
  ApiError,
  getCredentialNameForType,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { checkCredentialExists } from "../../../../../src/lib/model-provider/model-provider-service";

const router = tsr.router(modelProvidersCheckContract, {
  /**
   * GET /api/model-providers/check/:type - Check if credential exists
   */
  check: async ({ params }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const result = await checkCredentialExists(userId, params.type);

    return {
      status: 200 as const,
      body: {
        exists: result.exists,
        credentialName: getCredentialNameForType(params.type),
        currentType: result.currentType,
      },
    };
  },
});

/**
 * Custom error handler for model providers check API
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

const handler = createHandler(modelProvidersCheckContract, router, {
  errorHandler,
});

export { handler as GET };
