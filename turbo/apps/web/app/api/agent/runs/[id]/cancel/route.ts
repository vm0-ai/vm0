import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { runsCancelContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { cancelRun } from "../../../../../../src/lib/zero/zero-run-cancel";
import { dispatchCancelSideEffects } from "../../../../../../src/lib/infra/run/run-service";
import {
  dispatchQueuedZeroRun,
  drainOrgQueue,
} from "../../../../../../src/lib/zero/zero-run-queue-service";
import { processOrgCredits } from "../../../../../../src/lib/zero/credit/credit-service";
import {
  isNotFound,
  isBadRequest,
} from "../../../../../../src/lib/shared/errors";
import { logger } from "../../../../../../src/lib/shared/logger";
import { publishUserSignal } from "../../../../../../src/lib/infra/realtime/client";
import { getOrgMemberUserIds } from "../../../../../../src/lib/infra/realtime/audience";
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
      orgId = sandboxRun.orgId;
    } else {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    }

    try {
      const result = await cancelRun(runId, userId, orgId);

      after(async () => {
        const shouldProcessCredits = await dispatchCancelSideEffects(
          result,
          (orgId) => {
            return drainOrgQueue(orgId, dispatchQueuedZeroRun);
          },
        );
        if (shouldProcessCredits) {
          await processOrgCredits(result.orgId);
        }

        // Notify run owner that run was cancelled
        await publishUserSignal([userId], `thread:${runId}`);
        // Notify org members that task list may have changed
        const orgMembers = await getOrgMemberUserIds(result.orgId);
        await publishUserSignal(orgMembers, `tasks:${result.orgId}`);
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
