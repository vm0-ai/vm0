import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { schedulesByNameContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { scheduleService } from "../../../../../src/lib/schedule";
import { logger } from "../../../../../src/lib/logger";
import { NotFoundError } from "../../../../../src/lib/errors";

const log = logger("api:schedules:name");

const router = tsr.router(schedulesByNameContract, {
  getByName: async ({ params, query, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    log.debug(`Getting schedule ${params.name} for compose ${query.composeId}`);

    try {
      const schedule = await scheduleService.getByName(
        userId,
        query.composeId,
        params.name,
      );

      return {
        status: 200 as const,
        body: schedule,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          status: 404 as const,
          body: {
            error: { message: error.message, code: "NOT_FOUND" },
          },
        };
      }
      throw error;
    }
  },

  delete: async ({ params, query, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    log.debug(
      `Deleting schedule ${params.name} for compose ${query.composeId}`,
    );

    try {
      await scheduleService.delete(userId, query.composeId, params.name);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          status: 404 as const,
          body: {
            error: { message: error.message, code: "NOT_FOUND" },
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

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(schedulesByNameContract, router, {
  errorHandler,
});

export { handler as GET, handler as DELETE };
