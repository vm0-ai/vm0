import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  deploySchedule,
  listSchedules,
} from "../../../../src/lib/zero/schedule";
import {
  isNotFound,
  isBadRequest,
  isForbidden,
  isSchedulePast,
} from "@vm0/api-services/errors";

const router = tsr.router(zeroSchedulesMainContract, {
  deploy: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      const {
        org: { orgId },
      } = await resolveOrg(authCtx);

      const result = await deploySchedule(userId, orgId, {
        name: body.name,
        agentId: body.agentId,
        cronExpression: body.cronExpression,
        atTime: body.atTime,
        intervalSeconds: body.intervalSeconds,
        timezone: body.timezone,
        prompt: body.prompt,
        description: body.description,
        appendSystemPrompt: body.appendSystemPrompt,
        enabled: body.enabled,
        volumeVersions: body.volumeVersions,
        modelProviderId: body.modelProviderId,
        selectedModel: body.selectedModel,
        preferPersonalProvider: body.preferPersonalProvider,
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

  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
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
  routeName: "zero.schedules",
});

export { handler as GET, handler as POST };
