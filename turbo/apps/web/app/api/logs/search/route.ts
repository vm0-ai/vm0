import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { logsSearchContract, type RunEvent } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { and, eq, inArray } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../src/lib/axiom";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: unknown;
}

/**
 * Escape a string for use inside APL string literals.
 * Prevents APL injection by escaping double quotes and backslashes.
 */
function escapeApl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Look up agent names for a set of run IDs by joining agent_runs → compose_versions → composes.
 */
async function getAgentNames(
  runIds: string[],
  userId: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (runIds.length === 0) return result;

  const rows = await globalThis.services.db
    .select({
      runId: agentRuns.id,
      composeName: agentComposes.name,
    })
    .from(agentRuns)
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(and(inArray(agentRuns.id, runIds), eq(agentRuns.userId, userId)));

  for (const row of rows) {
    result.set(row.runId, row.composeName || "unknown");
  }

  return result;
}

/**
 * Filter run IDs by agent name. Returns only run IDs whose agent matches the given name.
 */
async function filterRunIdsByAgent(
  userId: string,
  agentName: string,
): Promise<string[]> {
  const rows = await globalThis.services.db
    .select({ runId: agentRuns.id })
    .from(agentRuns)
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(
      and(eq(agentRuns.userId, userId), eq(agentComposes.name, agentName)),
    );

  return rows.map((r) => r.runId);
}

const router = tsr.router(logsSearchContract, {
  searchLogs: async ({ query, headers }) => {
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

    const { keyword, agent, runId, limit, before, after } = query;
    const since = query.since ?? Date.now() - SEVEN_DAYS_MS;
    const sinceISO = new Date(since).toISOString();
    const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
    const escapedKeyword = escapeApl(keyword);

    // If agent filter is provided, resolve matching run IDs first
    let agentRunIds: string[] | undefined;
    if (agent) {
      agentRunIds = await filterRunIdsByAgent(userId, agent);
      if (agentRunIds.length === 0) {
        return {
          status: 200 as const,
          body: { results: [], hasMore: false },
        };
      }
    }

    // Build run ID filter for APL
    let runIdFilter = "";
    if (runId) {
      runIdFilter = `| where runId == "${escapeApl(runId)}"`;
    } else if (agentRunIds) {
      const runIdList = agentRunIds
        .map((id) => `"${escapeApl(id)}"`)
        .join(", ");
      runIdFilter = `| where runId in (${runIdList})`;
    }

    // Step 1: Search for matching events
    const searchApl = `['${dataset}']
| search "*${escapedKeyword}*"
| where userId == "${escapeApl(userId)}"
| where _time > datetime("${sinceISO}")
${runIdFilter}
| order by _time desc
| limit ${limit + 1}`;

    const matchedEvents = await queryAxiom<AxiomAgentEvent>(searchApl);

    // If Axiom is not configured, return empty results
    if (matchedEvents === null || matchedEvents.length === 0) {
      return {
        status: 200 as const,
        body: { results: [], hasMore: false },
      };
    }

    const hasMore = matchedEvents.length > limit;
    const matches = hasMore ? matchedEvents.slice(0, limit) : matchedEvents;

    // Step 2: Build context query — fetch surrounding events for each match
    if (before === 0 && after === 0) {
      // No context needed, just return matched events
      const runIds = [...new Set(matches.map((e) => e.runId))];
      const agentNames = await getAgentNames(runIds, userId);

      const results = matches.map((match) => ({
        runId: match.runId,
        agentName: agentNames.get(match.runId) || "unknown",
        matchedEvent: toRunEvent(match),
        contextBefore: [] as RunEvent[],
        contextAfter: [] as RunEvent[],
      }));

      return {
        status: 200 as const,
        body: { results, hasMore },
      };
    }

    // Build context ranges per match
    const contextConditions = matches.map((match) => {
      const seqMin = Math.max(0, match.sequenceNumber - before);
      const seqMax = match.sequenceNumber + after;
      return `(runId == "${escapeApl(match.runId)}" and sequenceNumber >= ${seqMin} and sequenceNumber <= ${seqMax})`;
    });

    const contextApl = `['${dataset}']
| where userId == "${escapeApl(userId)}"
| where ${contextConditions.join("\n  or ")}
| order by runId asc, sequenceNumber asc`;

    const contextEvents = await queryAxiom<AxiomAgentEvent>(contextApl);

    // Build a lookup map: runId+sequenceNumber → event
    const contextMap = new Map<string, AxiomAgentEvent>();
    if (contextEvents) {
      for (const event of contextEvents) {
        contextMap.set(`${event.runId}:${event.sequenceNumber}`, event);
      }
    }

    // Assemble results
    const runIds = [...new Set(matches.map((e) => e.runId))];
    const agentNames = await getAgentNames(runIds, userId);

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

function toRunEvent(event: AxiomAgentEvent): RunEvent {
  return {
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    eventData: event.eventData,
    createdAt: event._time,
  };
}

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
