import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { runsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";

const router = tsr.router(runsByIdContract, {
  getById: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Query run from database - filter by userId and orgId for security
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.id),
          eq(agentRuns.userId, userId),
          eq(agentRuns.orgId, org.orgId),
        ),
      )
      .limit(1);

    if (!run) {
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
        runId: run.id,
        agentComposeVersionId: run.agentComposeVersionId,
        status: run.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "timeout",
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt,
        vars: run.vars as Record<string, string> | undefined,
        sandboxId: run.sandboxId || undefined,
        result: run.result as Record<string, unknown> | undefined,
        error: run.error || undefined,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString(),
        completedAt: run.completedAt?.toISOString(),
      },
    };
  },
});

const handler = createHandler(runsByIdContract, router);

export { handler as GET };
