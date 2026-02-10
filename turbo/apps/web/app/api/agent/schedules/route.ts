import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { schedulesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { deploySchedule, listSchedules } from "../../../../src/lib/schedule";
import { logger } from "../../../../src/lib/logger";
import { isNotFound, isBadRequest } from "../../../../src/lib/errors";

const log = logger("api:schedules");

const router = tsr.router(schedulesMainContract, {
  deploy: async ({ body, headers }) => {
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

    // Validate trigger (exactly one must be specified)
    if (!body.cronExpression && !body.atTime) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Either cronExpression or atTime must be specified",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    if (body.cronExpression && body.atTime) {
      return {
        status: 400 as const,
        body: {
          error: {
            message:
              "Cannot specify both cronExpression and atTime. Use one or the other.",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    log.debug(`Deploying schedule ${body.name} for compose ${body.composeId}`);

    try {
      // Note: vars and secrets are no longer accepted via API
      // They must be managed via platform tables (vm0 secret set, vm0 var set)
      const result = await deploySchedule(userId, {
        name: body.name,
        composeId: body.composeId,
        cronExpression: body.cronExpression,
        atTime: body.atTime,
        timezone: body.timezone,
        prompt: body.prompt,
        // vars and secrets removed - now managed via platform tables
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        volumeVersions: body.volumeVersions,
      });

      return {
        status: (result.created ? 201 : 200) as 201 | 200,
        body: result,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: error.message, code: "NOT_FOUND" },
          },
        };
      }
      if (isBadRequest(error)) {
        return {
          status: 409 as const,
          body: {
            error: { message: error.message, code: "SCHEDULE_LIMIT_REACHED" },
          },
        };
      }
      throw error;
    }
  },

  list: async ({ headers }) => {
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

    log.debug(`Listing schedules for user ${userId}`);

    const schedules = await listSchedules(userId);

    return {
      status: 200 as const,
      body: { schedules },
    };
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

const handler = createHandler(schedulesMainContract, router, {
  errorHandler,
});

export { handler as POST, handler as GET };
