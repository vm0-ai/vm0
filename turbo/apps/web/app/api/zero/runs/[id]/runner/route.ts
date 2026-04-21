import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { zeroRunRunnerContract, type SandboxReuseResult } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

const router = tsr.router(zeroRunRunnerContract, {
  getRunner: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
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

    return {
      status: 200 as const,
      body: {
        sandboxReuseResult: (row.sandboxReuseResult ??
          null) as SandboxReuseResult | null,
      },
    };
  },
});

const handler = createHandler(zeroRunRunnerContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs:runner"),
});

export { handler as GET };
