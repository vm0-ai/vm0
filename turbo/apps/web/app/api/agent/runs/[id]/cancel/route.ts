import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { runsCancelContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { getOrgData } from "../../../../../../src/lib/org/org-cache-service";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import {
  cancelRun,
  dispatchCancelSideEffects,
} from "../../../../../../src/lib/run/run-service";
import { dispatchQueuedZeroRun } from "../../../../../../src/lib/zero/zero-queue-service";
import { processOrgCredits } from "../../../../../../src/lib/credit/credit-service";
import { isNotFound, isBadRequest } from "../../../../../../src/lib/errors";
import { logger } from "../../../../../../src/lib/logger";
import { after } from "next/server";

const log = logger("api:runs:cancel");

const router = tsr.router(runsCancelContract, {
  cancel: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { id: runId } = params;

    // Resolve org: sandbox tokens derive org from the run; CLI/session use resolveOrg
    let orgId: string;
    if (isSandboxAuth(authCtx)) {
      const [sandboxRun] = await globalThis.services.db
        .select({ orgId: agentRuns.orgId })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, authCtx.runId), eq(agentRuns.userId, userId)),
        )
        .limit(1);
      if (!sandboxRun) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
        };
      }
      orgId = (await getOrgData(sandboxRun.orgId)).orgId;
    } else {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    }

    try {
      const result = await cancelRun(runId, userId, orgId);

      after(async () => {
        const shouldProcessCredits = await dispatchCancelSideEffects(
          result,
          dispatchQueuedZeroRun,
        );
        if (shouldProcessCredits) {
          await processOrgCredits(result.orgId);
        }
      });

      log.debug(
        `Run ${runId} cancelled by user ${userId}, sandbox: ${result.sandboxId ?? "none"}`,
      );

      return {
        status: 200 as const,
        body: {
          id: runId,
          status: "cancelled" as const,
          message: "Run cancelled successfully",
        },
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
      throw error;
    }
  },
});

const handler = createHandler(runsCancelContract, router);

export { handler as POST };
