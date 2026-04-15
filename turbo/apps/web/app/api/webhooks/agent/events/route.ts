import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookEventsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { zeroRuns } from "../../../../../src/db/schema/zero-run";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/shared/logger";
import { dispatchToEventConsumers } from "../../../../../src/lib/infra/event-consumer";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import { after } from "next/server";

const log = logger("webhook:events");

const router = tsr.router(webhookEventsContract, {
  send: async ({ body, headers }) => {
    initServices();

    // Authenticate with sandbox JWT and verify runId matches
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

    log.debug(
      `Received ${body.events.length} events for run ${body.runId} from user ${userId}`,
    );

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select({
        orgId: agentRuns.orgId,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Get first and last sequence numbers from the events
    // Note: events array is validated as non-empty by the contract
    const firstSequence = body.events[0]!.sequenceNumber;
    const lastSequence = body.events[body.events.length - 1]!.sequenceNumber;

    log.debug(
      `Dispatching events ${firstSequence}-${lastSequence} to consumers for run ${body.runId}`,
    );

    // Dispatch to all registered event consumers (Axiom, credit, chat-assistant, etc.).
    // Awaited (not deferred via next/server `after`) so that downstream pollers of
    // /api/agent/runs/:id/events — including the CLI — can see events as soon as the
    // webhook returns. With `after()`, fast mock-claude runs completed before Axiom
    // ingestion finished, leaving the CLI with no `● Bash(...)` rendering.
    // Per-consumer failures are swallowed inside the dispatcher (Promise.allSettled).
    await dispatchToEventConsumers(body.runId, body.events, {
      userId,
      orgId: run.orgId,
      modelProvider: run.modelProvider ?? undefined,
      selectedModel: run.selectedModel ?? undefined,
    });

    // Notify run owner that new events are available
    after(() => {
      return publishUserSignal([userId], `thread:${body.runId}`);
    });

    return {
      status: 200 as const,
      body: {
        received: body.events.length,
        firstSequence,
        lastSequence,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
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

const handler = createHandler(webhookEventsContract, router, {
  errorHandler,
});

export { handler as POST };
