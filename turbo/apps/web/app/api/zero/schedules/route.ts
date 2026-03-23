import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroSchedulesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { deploySchedule, listSchedules } from "../../../../src/lib/schedule";
import {
  isNotFound,
  isBadRequest,
  isForbidden,
  isSchedulePast,
} from "../../../../src/lib/errors";

const router = tsr.router(zeroSchedulesMainContract, {
  deploy: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const {
        org: { orgId },
      } = await resolveOrg(authCtx, orgSlug);

      const result = await deploySchedule(userId, orgId, {
        name: body.name,
        composeId: body.composeId,
        cronExpression: body.cronExpression,
        atTime: body.atTime,
        intervalSeconds: body.intervalSeconds,
        timezone: body.timezone,
        prompt: body.prompt,
        appendSystemPrompt: body.appendSystemPrompt,
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
            error: { message: error.message, code: "NOT_FOUND" },
          },
        };
      }
      if (isBadRequest(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: error.message, code: "BAD_REQUEST" },
          },
        };
      }
      if (isSchedulePast(error)) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: error.message,
              code: "SCHEDULE_PAST",
            },
          },
        };
      }
      throw error;
    }
  },

  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx, orgSlug);
      orgId = org.orgId;
    } catch (error) {
      if (isNotFound(error) || isForbidden(error) || isBadRequest(error)) {
        return {
          status: 200 as const,
          body: { schedules: [] },
        };
      }
      throw error;
    }

    const schedules = await listSchedules(userId, orgId);

    return {
      status: 200 as const,
      body: { schedules },
    };
  },
});

const handler = createHandler(zeroSchedulesMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-schedules"),
});

export { handler as GET, handler as POST };
