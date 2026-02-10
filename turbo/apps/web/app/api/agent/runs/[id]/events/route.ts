import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { runEventsContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentComposeVersions } from "../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../../src/lib/axiom";
import type {
  RunStatus,
  RunResult,
  RunState,
} from "../../../../../../src/lib/run/types";
import { filterConsecutiveEvents, type AxiomAgentEvent } from "./filter-events";
import { queryAgentEventsBySequence } from "../../../../../../src/lib/telemetry/local-store";

const router = tsr.router(runEventsContract, {
  getEvents: async ({ params, query, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { since, limit } = query;

    // Verify run exists and belongs to user, join with compose version to get framework
    const [runWithCompose] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        userId: agentRuns.userId,
        status: agentRuns.status,
        result: agentRuns.result,
        error: agentRuns.error,
        composeContent: agentComposeVersions.content,
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!runWithCompose || runWithCompose.userId !== userId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Extract framework from compose content
    const composeContent = runWithCompose.composeContent as {
      agent?: { framework?: string };
    } | null;
    const framework = composeContent?.agent?.framework ?? "claude-code";

    // Build APL query for Axiom
    const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
    const apl = `['${dataset}']
| where runId == "${params.id}"
| where sequenceNumber > ${since}
| order by sequenceNumber asc
| limit ${limit}`;

    // Query Axiom for agent events
    const axiomEvents = await queryAxiom<AxiomAgentEvent>(apl);

    // If Axiom is not configured or query failed, try DB fallback
    let rawEvents: AxiomAgentEvent[];
    if (axiomEvents !== null) {
      rawEvents = axiomEvents;
    } else {
      const dbEvents = await queryAgentEventsBySequence(
        params.id,
        since,
        limit,
      );
      rawEvents = dbEvents.map((e) => ({
        _time: e.createdAt.toISOString(),
        runId: params.id,
        userId,
        sequenceNumber: e.sequenceNumber,
        eventType: e.eventType,
        eventData: e.eventData,
      }));
    }

    // Filter to only consecutive events to handle Axiom's eventual consistency.
    const events = filterConsecutiveEvents(rawEvents, since);

    // Calculate nextSequence and hasMore
    // hasMore is true if we truncated due to gap OR if we hit the limit
    const hasMore =
      events.length < rawEvents.length || rawEvents.length === limit;
    const nextSequence =
      events.length > 0 ? events[events.length - 1]!.sequenceNumber : since;

    // Build run state from run record
    const runState: RunState = {
      status: runWithCompose.status as RunStatus,
    };

    // Include result if completed
    if (runWithCompose.status === "completed" && runWithCompose.result) {
      runState.result = runWithCompose.result as RunResult;
    }

    // Include error if failed
    if (runWithCompose.status === "failed" && runWithCompose.error) {
      runState.error = runWithCompose.error;
    }

    return {
      status: 200 as const,
      body: {
        events: events.map((e) => ({
          sequenceNumber: e.sequenceNumber,
          eventType: e.eventType,
          eventData: e.eventData,
          createdAt: e._time,
        })),
        hasMore,
        nextSequence,
        run: runState,
        framework,
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    ("pathParamsError" in err || "queryError" in err)
  ) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
      queryError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
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

const handler = createHandler(runEventsContract, router, {
  errorHandler,
});

export { handler as GET };
