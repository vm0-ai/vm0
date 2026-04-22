import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookUsageEventContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { usageEvent } from "../../../../../src/db/schema/usage-event";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("webhooks:usage-event");

const router = tsr.router(webhookUsageEventContract, {
  send: async ({ body, headers }) => {
    initServices();

    const auth = getSandboxAuthForRun(body.runId, headers.authorization);
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated or runId mismatch",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const { userId } = auth;

    const [run] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: "Run not found",
            code: "NOT_FOUND",
          },
        },
      };
    }

    await globalThis.services.db
      .insert(usageEvent)
      .values({
        runId: body.runId,
        orgId: run.orgId,
        userId,
        kind: body.kind,
        provider: body.provider,
        category: body.category,
        quantity: body.quantity,
        idempotencyKey: body.idempotencyKey,
      })
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });

    log.debug("Usage event recorded", {
      runId: body.runId,
      kind: body.kind,
      provider: body.provider,
      category: body.category,
      quantity: body.quantity,
    });

    return {
      status: 200 as const,
      body: {
        success: true,
      },
    };
  },
});

function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
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
  }
  return undefined;
}

const handler = createHandler(webhookUsageEventContract, router, {
  routeName: "webhooks.agent.usage-event",
  errorHandler,
});

export { handler as POST };
