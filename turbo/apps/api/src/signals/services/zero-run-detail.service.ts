import { computed, type Computed } from "ccstate";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  AgentEventsResponse,
  AxiomNetworkEvent,
  NetworkLogsResponse,
  RunEvent,
} from "@vm0/api-contracts/contracts/runs";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

import { db$, type Db } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";

type ServiceDb = Pick<Db, "select">;

interface AgentComposeContent {
  agents: Record<string, { framework: string }>;
}

function extractFramework(composeContent: unknown): string {
  const content = composeContent as AgentComposeContent | null;
  const agentNames = content?.agents ? Object.keys(content.agents) : [];
  const firstAgent =
    agentNames.length > 0 ? content?.agents[agentNames[0]!] : null;
  return firstAgent?.framework ?? "claude-code";
}

async function verifyRunOwnership(
  db: ServiceDb,
  runId: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    )
    .limit(1);
  return run !== undefined;
}

interface NetworkLogsParams {
  runId: string;
  userId: string;
  orgId: string;
  since?: number;
  limit: number;
  order: "asc" | "desc";
}

export function zeroRunContext(
  runId: string,
  userId: string,
  orgId: string,
): Computed<Promise<RunContextResponse | null>> {
  return computed(async (get): Promise<RunContextResponse | null> => {
    const db = get(db$);

    const owned = await verifyRunOwnership(db, runId, userId, orgId);
    if (!owned) {
      return null;
    }

    // Get run metadata for vars
    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        vars: agentRuns.vars,
        secretNames: agentRuns.secretNames,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return null;
    }

    const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (sanitizedRunId !== runId) {
      return null;
    }

    const dataset = getDatasetName("run-context");
    const apl = `['${dataset}']
| where runId == "${sanitizedRunId}"
| limit 1`;

    const results = (await get(queryAxiom(apl))) as Record<string, unknown>[];
    const snapshot = results[0] as
      | (Omit<
          RunContextResponse,
          "vars" | "prompt" | "appendSystemPrompt" | "runId" | "secretNames"
        > & {
          sessionId?: string;
          environment?: Record<string, string>;
          firewalls?: RunContextResponse["firewalls"];
          networkPolicies?: RunContextResponse["networkPolicies"];
          volumes?: RunContextResponse["volumes"];
          artifact?: RunContextResponse["artifact"];
          featureFlags?: RunContextResponse["featureFlags"];
        })
      | undefined;

    if (!snapshot) {
      return null;
    }

    return {
      prompt: run.prompt,
      appendSystemPrompt: run.appendSystemPrompt ?? null,
      runId,
      sessionId: (snapshot.sessionId as string) ?? null,
      secretNames: (run.secretNames as string[]) ?? [],
      vars: (run.vars as Record<string, string> | undefined) ?? null,
      environment: (snapshot.environment as Record<string, string>) ?? {},
      firewalls: (snapshot.firewalls as RunContextResponse["firewalls"]) ?? [],
      networkPolicies:
        (snapshot.networkPolicies as RunContextResponse["networkPolicies"]) ??
        null,
      volumes: (snapshot.volumes as RunContextResponse["volumes"]) ?? [],
      artifact: (snapshot.artifact as RunContextResponse["artifact"]) ?? null,
      featureFlags:
        (snapshot.featureFlags as RunContextResponse["featureFlags"]) ?? null,
    };
  });
}

export function zeroRunNetworkLogs(
  params: NetworkLogsParams,
): Computed<Promise<NetworkLogsResponse | null>> {
  return computed(async (get): Promise<NetworkLogsResponse | null> => {
    const db = get(db$);

    const owned = await verifyRunOwnership(
      db,
      params.runId,
      params.userId,
      params.orgId,
    );
    if (!owned) {
      return null;
    }

    const { since, limit, order } = params;

    const dataset = getDatasetName("sandbox-telemetry-network");
    const sinceFilter = since
      ? `| where _time > datetime("${new Date(since).toISOString()}")`
      : "";
    const apl = `['${dataset}']
| where runId == "${params.runId}"
${sinceFilter}
| order by _time ${order}
| limit ${limit + 1}`;

    const events = (await get(queryAxiom(apl))) as AxiomNetworkEvent[];

    const hasMore = events.length > limit;
    const records = hasMore ? events.slice(0, limit) : events;

    const networkLogs = records.map((e) => {
      return {
        timestamp: e._time,
        type: e.type,
        action: e.action,
        host: e.host,
        port: e.port,
        method: e.method,
        url: e.url,
        status: e.status,
        latency_ms: e.latency_ms,
        request_size: e.request_size,
        response_size: e.response_size,
        dns_event: e.dns_event,
        dns_query_type: e.dns_query_type,
        dns_result: e.dns_result,
        dns_serial: e.dns_serial,
        firewall_base: e.firewall_base,
        firewall_name: e.firewall_name,
        firewall_permission: e.firewall_permission,
        firewall_rule_match: e.firewall_rule_match,
        firewall_params: e.firewall_params,
        firewall_billable: e.firewall_billable,
        firewall_error: e.firewall_error,
        auth_resolved_secrets: e.auth_resolved_secrets,
        auth_refreshed_connectors: e.auth_refreshed_connectors,
        auth_refreshed_secrets: e.auth_refreshed_secrets,
        auth_cache_hit: e.auth_cache_hit,
        auth_url_rewrite: e.auth_url_rewrite,
        error: e.error,
        request_headers: e.request_headers,
        request_body: e.request_body,
        request_body_encoding: e.request_body_encoding,
        request_body_truncated: e.request_body_truncated,
        response_headers: e.response_headers,
        response_body: e.response_body,
        response_body_encoding: e.response_body_encoding,
        response_body_truncated: e.response_body_truncated,
      };
    });

    return { networkLogs, hasMore };
  });
}

interface AgentEventsParams {
  runId: string;
  userId: string;
  orgId: string;
  since?: number;
  limit: number;
  order: "asc" | "desc";
}

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

export function zeroRunAgentEvents(
  params: AgentEventsParams,
): Computed<Promise<AgentEventsResponse | null>> {
  return computed(async (get): Promise<AgentEventsResponse | null> => {
    const db = get(db$);

    // Verify ownership and get compose content for framework extraction
    const [runWithCompose] = await db
      .select({
        id: agentRuns.id,
        composeContent: agentComposeVersions.content,
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);

    if (!runWithCompose) {
      return null;
    }

    const framework = extractFramework(runWithCompose.composeContent);

    const { since, limit, order } = params;

    const dataset = getDatasetName("agent-run-events");
    const sinceFilter =
      since !== undefined ? `| where sequenceNumber > ${since}` : "";
    const apl = `['${dataset}']
| where runId == "${params.runId}"
${sinceFilter}
| order by sequenceNumber ${order}
| limit ${limit + 1}`;

    const events = (
      await get(queryAxiom(apl))
    ).slice() as unknown as AxiomAgentEvent[];

    const hasMore = events.length > limit;
    const resultEvents = hasMore ? events.slice(0, limit) : events;

    return {
      events: resultEvents.map((e) => {
        return {
          sequenceNumber: e.sequenceNumber,
          eventType: e.eventType,
          eventData: e.eventData,
          createdAt: e._time,
        } satisfies RunEvent;
      }),
      hasMore,
      framework,
    };
  });
}
