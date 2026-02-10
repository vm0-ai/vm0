import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookEventsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/logger";
import {
  ingestToAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";
import { publishEvents } from "../../../../../src/lib/realtime/client";
import { storeAgentEvents } from "../../../../../src/lib/telemetry/local-store";

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

    // Events are already masked client-side in the sandbox before sending
    // No server-side masking needed - secrets values are never stored
    const axiomEvents = body.events.map(
      (event: {
        type: string;
        sequenceNumber: number;
        [key: string]: unknown;
      }) => ({
        runId: body.runId,
        userId,
        sequenceNumber: event.sequenceNumber,
        eventType: event.type,
        eventData: event, // Already masked by client
      }),
    );

    // Ingest events to Axiom
    const axiomDataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
    const ingested = await ingestToAxiom(axiomDataset, axiomEvents);

    // DB fallback: store events locally when Axiom is not configured
    if (!ingested) {
      storeAgentEvents(
        body.runId,
        body.events.map(
          (event: {
            type: string;
            sequenceNumber: number;
            [key: string]: unknown;
          }) => ({
            sequenceNumber: event.sequenceNumber,
            eventType: event.type,
            eventData: event as Record<string, unknown>,
          }),
        ),
      ).catch((err: unknown) => {
        log.error("DB agent events store failed:", err);
      });
    }

    // Get first and last sequence numbers from the events
    // Note: events array is validated as non-empty by the contract
    const firstSequence = body.events[0]!.sequenceNumber;
    const lastSequence = body.events[body.events.length - 1]!.sequenceNumber;

    log.debug(
      `Ingested events ${firstSequence}-${lastSequence} to Axiom for run ${body.runId}`,
    );

    // Publish events to Ably for realtime streaming to CLI
    // Non-blocking - errors are logged but don't affect response
    await publishEvents(body.runId, body.events, lastSequence + 1);

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
