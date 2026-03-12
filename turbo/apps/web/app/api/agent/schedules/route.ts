import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { schedulesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { deploySchedule, listSchedules } from "../../../../src/lib/schedule";
import { logger } from "../../../../src/lib/logger";
import { isNotFound, isBadRequest } from "../../../../src/lib/errors";
import { resolveOrgId } from "../../../../src/lib/scope/org-member-service";

const log = logger("api:schedules");

const router = tsr.router(schedulesMainContract, {
  deploy: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    log.debug(`Deploying schedule ${body.name} for compose ${body.composeId}`);

    try {
      // Note: vars and secrets are no longer accepted via API
      // They must be managed via platform tables (vm0 secret set, vm0 var set)
      const orgId = await resolveOrgId(userId, undefined, tokenOrgId);

      const result = await deploySchedule(userId, orgId, {
        name: body.name,
        composeId: body.composeId,
        cronExpression: body.cronExpression,
        atTime: body.atTime,
        intervalSeconds: body.intervalSeconds,
        timezone: body.timezone,
        prompt: body.prompt,
        enabled: body.enabled,
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
            error: { message: "Resource not found", code: "NOT_FOUND" },
          },
        };
      }
      if (isBadRequest(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: "Invalid request", code: "BAD_REQUEST" },
          },
        };
      }
      throw error;
    }
  },

  list: async ({ headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

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
