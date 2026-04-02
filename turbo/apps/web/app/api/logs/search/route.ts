import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { logsSearchContract, type RunEvent } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { and, eq } from "drizzle-orm";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { getDatasetName, DATASETS } from "../../../../src/lib/axiom";
import {
  SEVEN_DAYS_MS,
  getUserRunIds,
  searchEventsInAxiom,
  fetchContextEvents,
  getAgentNames,
  buildRunIdFilter,
  toRunEvent,
} from "../../../../src/lib/run/log-search-service";

const router = tsr.router(logsSearchContract, {
  searchLogs: async ({ query, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const { keyword, agent, runId, limit, before, after } = query;
    const since = query.since ?? Date.now() - SEVEN_DAYS_MS;
    const sinceDate = new Date(since);
    const sinceISO = sinceDate.toISOString();
    const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);

    // Determine which run IDs to search (ownership verified via DB).
    let targetRunIds: string[];
    if (runId) {
      const [run] = await globalThis.services.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.userId, userId),
            eq(agentRuns.orgId, org.orgId),
          ),
        )
        .limit(1);

      if (!run) {
        return {
          status: 200 as const,
          body: { results: [], hasMore: false },
        };
      }
      targetRunIds = [runId];
    } else {
      targetRunIds = await getUserRunIds(userId, org.orgId, sinceDate, agent);
      if (targetRunIds.length === 0) {
        return {
          status: 200 as const,
          body: { results: [], hasMore: false },
        };
      }
    }

    const runIdFilter = buildRunIdFilter(targetRunIds);

    const matchedEvents = await searchEventsInAxiom(
      dataset,
      sinceISO,
      runIdFilter,
      keyword,
      limit,
    );

    if (matchedEvents.length === 0) {
      return {
        status: 200 as const,
        body: { results: [], hasMore: false },
      };
    }

    const hasMore = matchedEvents.length > limit;
    const matches = hasMore ? matchedEvents.slice(0, limit) : matchedEvents;

    // Fetch context events
    const contextMap = await fetchContextEvents(
      dataset,
      matches,
      before,
      after,
    );

    // Assemble results
    const matchedRunIds = [
      ...new Set(
        matches.map((e) => {
          return e.runId;
        }),
      ),
    ];
    const agentNames = await getAgentNames(matchedRunIds, userId, org.orgId);

    const results = matches.map((match) => {
      const contextBefore: RunEvent[] = [];
      const contextAfter: RunEvent[] = [];

      for (
        let i = match.sequenceNumber - before;
        i < match.sequenceNumber;
        i++
      ) {
        const event = contextMap.get(`${match.runId}:${i}`);
        if (event) contextBefore.push(toRunEvent(event));
      }

      for (
        let i = match.sequenceNumber + 1;
        i <= match.sequenceNumber + after;
        i++
      ) {
        const event = contextMap.get(`${match.runId}:${i}`);
        if (event) contextAfter.push(toRunEvent(event));
      }

      return {
        runId: match.runId,
        agentName: agentNames.get(match.runId) || "unknown",
        matchedEvent: toRunEvent(match),
        contextBefore,
        contextAfter,
      };
    });

    return {
      status: 200 as const,
      body: { results, hasMore },
    };
  },
});

function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "queryError" in err) {
    const validationError = err as {
      queryError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.queryError?.issues[0]) {
      const issue = validationError.queryError.issues[0];
      const path = issue.path.join(".");
      const message = path ? `${path}: ${issue.message}` : issue.message;
      return TsRestResponse.fromJson(
        { error: { message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
  }

  return undefined;
}

const handler = createHandler(logsSearchContract, router, {
  errorHandler,
});

export { handler as GET };
