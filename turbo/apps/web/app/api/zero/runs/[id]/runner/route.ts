import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroRunRunnerContract } from "@vm0/api-contracts/contracts/zero-runs";
import { sandboxReuseResultSchema } from "@vm0/api-contracts/contracts/webhooks";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

const router = tsr.router(zeroRunRunnerContract, {
  getRunner: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const [row] = await globalThis.services.db
      .select({ sandboxReuseResult: agentRuns.sandboxReuseResult })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.id),
          eq(agentRuns.userId, userId),
          eq(agentRuns.orgId, org.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Validate the DB value at the API boundary instead of blind-casting —
    // if the runner ever writes an enum value the zod schema doesn't know
    // about, we want to fail fast here (500) rather than crash the UI on a
    // missing `SANDBOX_REUSE_LABELS[...]` lookup.
    const sandboxReuseResult = sandboxReuseResultSchema
      .nullable()
      .parse(row.sandboxReuseResult ?? null);

    return {
      status: 200 as const,
      body: { sandboxReuseResult },
    };
  },
});

const handler = createHandler(zeroRunRunnerContract, router, {
  routeName: "zero.runs.runner",
});

export { handler as GET };
