import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { secretsContract } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  upsertSecret,
  listSecrets,
  deleteSecret,
} from "../../../src/lib/secrets/secrets-service";

const router = tsr.router(secretsContract, {
  list: async () => {
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

    const secrets = await listSecrets(userId);
    return { status: 200 as const, body: { secrets } };
  },

  create: async ({ body }) => {
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

    const result = await upsertSecret(userId, body.name, body.value);

    if (result.action === "created") {
      return {
        status: 201 as const,
        body: { name: body.name, action: "created" as const },
      };
    }

    return {
      status: 200 as const,
      body: { name: body.name, action: "updated" as const },
    };
  },

  delete: async ({ query }) => {
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

    const deleted = await deleteSecret(userId, query.name);

    if (!deleted) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Secret not found: ${query.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: { name: query.name, deleted: true as const },
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
        if (field === "name") {
          if (message.includes("start with a letter")) {
            message =
              "Invalid secret name. Must start with a letter and contain only letters, numbers, and underscores.";
          } else if (message.includes("255 characters")) {
            message = "Secret name must be 255 characters or less";
          } else {
            message = "Missing or invalid name";
          }
        } else if (field === "value") {
          if (message.includes("48 KB")) {
            message = "Secret value must be 48 KB or less";
          } else {
            message = "Missing or invalid value";
          }
        }

        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

    // Handle query validation errors
    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        const field = issue.path[0];
        let message = issue.message;

        // Map error messages to match existing API format
        if (field === "name") {
          message = "Missing name query parameter";
        }

        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  // Let other errors propagate
  return undefined;
}

const handler = createNextHandler(secretsContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as GET, handler as POST, handler as DELETE };
