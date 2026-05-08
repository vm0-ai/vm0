import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { runEventsContract } from "@vm0/api-contracts/contracts/runs";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../../src/lib/shared/axiom";
import type {
  RunStatus,
  RunResult,
  RunState,
} from "../../../../../../src/lib/infra/run/types";
import { extractFrameworkFromCompose } from "../../../../../../src/lib/infra/framework/framework-config";
import { filterConsecutiveEvents, type AxiomAgentEvent } from "./filter-events";

const router = tsr.router(runEventsContract, {
  getEvents: async ({ params, query, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const { since, limit } = query;

    const { org } = await resolveOrg(authCtx);

    // Verify run exists and belongs to user+org, join with compose version to get framework
    const [runWithCompose] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        result: agentRuns.result,
        error: agentRuns.error,
        lastEventSequence: agentRuns.lastEventSequence,
        composeContent: agentComposeVersions.content,
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentRuns.id, params.id),
          eq(agentRuns.userId, userId),
          eq(agentRuns.orgId, org.orgId),
        ),
      )
      .limit(1);

    if (!runWithCompose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Extract framework from compose content. Stored composes nest agents
    // under `agents.<name>.framework`; `extractFrameworkFromCompose` handles
    // both that shape and the legacy `agent.framework` form. Falls back to
    // claude-code so old rows that pre-date the framework field continue to
    // route through the Claude parser.
    const framework =
      extractFrameworkFromCompose(
        runWithCompose.composeContent as Parameters<
          typeof extractFrameworkFromCompose
        >[0],
      ) ?? "claude-code";

    // Build APL query for Axiom
    const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
    const apl = `['${dataset}']
| where runId == "${params.id}"
| where sequenceNumber > ${since}
| order by sequenceNumber asc
| limit ${limit}`;

    // Query Axiom for agent events
    const rawEvents = await queryAxiom<AxiomAgentEvent>(apl);

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

    if (runWithCompose.lastEventSequence !== null) {
      runState.lastEventSequence = runWithCompose.lastEventSequence;
    }

    return {
      status: 200 as const,
      body: {
        events: events.map((e) => {
          return {
            sequenceNumber: e.sequenceNumber,
            eventType: e.eventType,
            eventData: e.eventData,
            createdAt: e._time,
          };
        }),
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
  routeName: "agent.runs.events",
  errorHandler,
});

export { handler as GET };
