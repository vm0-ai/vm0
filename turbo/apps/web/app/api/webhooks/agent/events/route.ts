import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { webhookEventsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../../src/db/schema/agent-run-event";
import { eq, max, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import {
  createSecretMasker,
  decryptSecrets,
} from "../../../../../src/lib/crypto";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhook:events");

const router = tsr.router(webhookEventsContract, {
  send: async ({ body }) => {
    initServices();

    // Authenticate with sandbox JWT and verify runId matches
    const auth = await getSandboxAuthForRun(body.runId);
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
      .select()
      .from(agentRuns)
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

    // Get the last sequence number for this run
    const [lastEvent] = await globalThis.services.db
      .select({ maxSeq: max(agentRunEvents.sequenceNumber) })
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, body.runId));

    const lastSequence = lastEvent?.maxSeq ?? 0;

    // Get secrets from run record and create masker for protecting sensitive data
    // Secrets are stored encrypted per-value in the run record
    let secretValues: string[] = [];
    if (run.secrets && typeof run.secrets === "object") {
      const encryptedSecrets = run.secrets as Record<string, string>;
      const decrypted = decryptSecrets(encryptedSecrets);
      secretValues = Object.values(decrypted);
    }
    const masker = createSecretMasker(secretValues);

    // Prepare events for insertion with secrets masked
    const eventsToInsert = body.events.map((event, index) => ({
      runId: body.runId,
      sequenceNumber: lastSequence + index + 1,
      eventType: event.type,
      eventData: masker.mask(event),
    }));

    // Insert events in batch
    await globalThis.services.db.insert(agentRunEvents).values(eventsToInsert);

    const firstSequence = lastSequence + 1;
    const lastInsertedSequence = lastSequence + body.events.length;

    log.debug(
      `Stored events ${firstSequence}-${lastInsertedSequence} for run ${body.runId}`,
    );

    return {
      status: 200 as const,
      body: {
        received: body.events.length,
        firstSequence,
        lastSequence: lastInsertedSequence,
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

const handler = createNextHandler(webhookEventsContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
