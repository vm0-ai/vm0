import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { schedulesDisableContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { disableSchedule } from "../../../../../../src/lib/schedule";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound } from "../../../../../../src/lib/errors";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";

const log = logger("api:schedules:disable");

const router = tsr.router(schedulesDisableContract, {
  disable: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const {
      org: { orgId },
    } = await resolveOrg(authCtx, orgSlug);

    log.debug(
      `Disabling schedule ${params.name} for compose ${body.composeId}`,
    );

    try {
      const schedule = await disableSchedule(
        userId,
        orgId,
        body.composeId,
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
});

function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError?: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          {
            error: {
              message: "composeId must be a valid UUID",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }
    }
  }

  // Handle invalid JSON body (SyntaxError from JSON.parse)
  if (err instanceof SyntaxError) {
    return TsRestResponse.fromJson(
      {
        error: {
          message: "composeId must be a valid UUID",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  return undefined;
}

const handler = createHandler(schedulesDisableContract, router, {
  errorHandler,
});

export { handler as POST };
