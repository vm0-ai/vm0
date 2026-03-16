import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { schedulesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { deploySchedule, listSchedules } from "../../../../src/lib/schedule";
import { logger } from "../../../../src/lib/logger";
import {
  isNotFound,
  isBadRequest,
  isForbidden,
} from "../../../../src/lib/errors";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";

const log = logger("api:schedules");

const router = tsr.router(schedulesMainContract, {
  deploy: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    log.debug(`Deploying schedule ${body.name} for compose ${body.composeId}`);

    try {
      // Note: vars and secrets are no longer accepted via API
      // They must be managed via platform tables (vm0 secret set, vm0 var set)
      const orgSlug = new URL(request.url).searchParams.get("org");
      const {
        org: { orgId },
      } = await resolveOrg(userId, orgSlug);

      const result = await deploySchedule(userId, orgId, {
        name: body.name,
        composeId: body.composeId,
        cronExpression: body.cronExpression,
        atTime: body.atTime,
        intervalSeconds: body.intervalSeconds,
        timezone: body.timezone,
        prompt: body.prompt,
        enabled: body.enabled,
        notifyEmail: body.notifyEmail,
        notifySlack: body.notifySlack,
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

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Resolve active org — scope schedules to the user's current org
    let orgId: string;
    try {
      const { org } = await resolveOrg(userId);
      orgId = org.orgId;
    } catch (error) {
      if (isNotFound(error) || isForbidden(error)) {
        return {
          status: 200 as const,
          body: { schedules: [] },
        };
      }
      throw error;
    }

    log.debug(`Listing schedules for user ${userId} in org ${orgId}`);

    const schedules = await listSchedules(userId, orgId);

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
