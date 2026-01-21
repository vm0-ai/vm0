import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../../src/lib/ts-rest-handler";
import { runAgentEventsContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { agentComposeVersions } from "../../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../../../src/lib/auth/get-user-id";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../../../src/lib/axiom";

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

const router = tsr.router(runAgentEventsContract, {
  getAgentEvents: async ({ params, query }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Verify run exists and belongs to user, join with compose version to get framework
    const [runWithCompose] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        userId: agentRuns.userId,
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

    const { since, limit, order } = query;

    // Build APL query for Axiom
    const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
    const sinceFilter = since
      ? `| where _time > datetime("${new Date(since).toISOString()}")`
      : "";
    const apl = `['${dataset}']
| where runId == "${params.id}"
${sinceFilter}
| order by _time ${order}
| limit ${limit + 1}`;

    // Query Axiom for agent events
    const events = await queryAxiom<AxiomAgentEvent>(apl);

    // If Axiom is not configured or query failed, return empty
    if (events === null) {
      return {
        status: 200 as const,
        body: {
          events: [],
          hasMore: false,
          framework,
        },
      };
    }

    // Check if there are more events
    const hasMore = events.length > limit;
    const resultEvents = hasMore ? events.slice(0, limit) : events;

    return {
      status: 200 as const,
      body: {
        events: resultEvents.map((e) => ({
          sequenceNumber: e.sequenceNumber,
          eventType: e.eventType,
          eventData: e.eventData,
          createdAt: e._time,
        })),
        hasMore,
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

const handler = createHandler(runAgentEventsContract, router, {
  errorHandler,
});

export { handler as GET };
