import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { schedulesByNameContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import {
  getScheduleByName,
  deleteSchedule,
} from "../../../../../src/lib/schedule";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";

const log = logger("api:schedules:name");

const router = tsr.router(schedulesByNameContract, {
  getByName: async ({ params, query, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization, {
      requiredCapability: "schedule:read",
    });
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    log.debug(`Getting schedule ${params.name} for compose ${query.composeId}`);

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const {
        org: { orgId },
      } = await resolveOrg(userId, orgSlug);

      const schedule = await getScheduleByName(
        userId,
        orgId,
        query.composeId,
        params.name,
      );

      return {
        status: 200 as const,
        body: schedule,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Resource not found", code: "NOT_FOUND" },
          },
        };
      }
      throw error;
    }
  },

  delete: async ({ params, query, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization, {
      requiredCapability: "schedule:write",
    });
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    log.debug(
      `Deleting schedule ${params.name} for compose ${query.composeId}`,
    );

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const {
        org: { orgId },
      } = await resolveOrg(userId, orgSlug);

      await deleteSchedule(userId, orgId, query.composeId, params.name);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Resource not found", code: "NOT_FOUND" },
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
