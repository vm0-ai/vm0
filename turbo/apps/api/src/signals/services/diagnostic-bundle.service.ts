import { randomUUID } from "node:crypto";

import archiver from "archiver";
import { eq, or, sql } from "drizzle-orm";
import type { AxiomNetworkEvent } from "@vm0/api-contracts/contracts/runs";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import type { Computed } from "ccstate";

import { escapeAplString } from "../../lib/axiom-apl";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { waitForRunEventWatermarkVisible } from "../../lib/agent-event-visibility";
import { clerk$ } from "../external/clerk";
import { getDatasetName, queryAxiom } from "../external/axiom";
import { generatePresignedGetUrl, putS3Object } from "../external/s3";
import { db$, type Db } from "../external/db";
import { settle, tapError } from "../utils";
import { zeroConnectorList } from "./zero-connector-data.service";
import { createPlainSupportThread } from "./plain-support.service";

const log = logger("service:diagnostic-bundle");

const DOWNLOAD_EXPIRY_SECONDS = 72 * 60 * 60;
const AGENT_EVENT_WATERMARK_WAIT_CONCURRENCY = 4;

type ComputedGetter = <T>(computedValue: Computed<T>) => T;
type ServiceDb = Pick<Db, "select">;

interface ZipEntry {
  readonly path: string;
  readonly content: string;
}

interface AxiomAgentEvent {
  readonly _time: string;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly eventData: Record<string, unknown>;
}

type ChatHistoryEvent = AxiomAgentEvent;

interface RunMeta {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly status: string;
  readonly error: string | null;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly lastEventSequence: number | null;
  readonly runnerGroup: string | null;
  readonly continuedFromSessionId: string | null;
  readonly result: unknown;
}

interface DiagnosticRunRecord extends RunMeta {
  readonly agentComposeVersionId: string | null;
}

interface AgentMeta {
  readonly displayName?: string | null;
  readonly composeContent?: unknown;
}

interface AgentConfigShape {
  readonly framework?: string;
  readonly modelProvider?: string;
  readonly selectedModel?: string;
}

interface DiagnosticBundleParams {
  readonly title: string;
  readonly description?: string;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly run: DiagnosticRunRecord;
  readonly referencePrefix: string;
  readonly s3PathPrefix: string;
  readonly emailSubjectPrefix: string;
}

interface DiagnosticBundleResult {
  readonly reference: string;
}

interface ZipEntryParams {
  readonly reference: string;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly sessionId: string | null;
  readonly title: string;
  readonly description: string | undefined;
  readonly chatHistory: readonly ChatHistoryEvent[];
  readonly run: DiagnosticRunRecord;
  readonly safeConnectors: readonly Record<string, unknown>[];
  readonly agentConfig: Record<string, unknown>;
  readonly activityLogs: readonly unknown[];
  readonly systemLogText: string;
  readonly networkLogEntries: readonly Record<string, unknown>[];
}

interface UploadResult {
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

async function assembleZip(entries: readonly ZipEntry[]): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];

  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    archive.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    archive.on("error", reject);
  });

  for (const entry of entries) {
    archive.append(Buffer.from(entry.content), { name: entry.path });
  }

  await archive.finalize();
  return done;
}

export async function submitDiagnosticBundle(
  get: ComputedGetter,
  params: DiagnosticBundleParams,
): Promise<DiagnosticBundleResult> {
  const { title, description, userId, orgId, runId, run } = params;
  const reference = `${params.referencePrefix}-${randomUUID().slice(0, 8)}`;
  const sessionId = run.continuedFromSessionId;
  const db = getDb(get);

  const [connectors, agentConfig, sessionRuns] = await Promise.all([
    collectConnectors(get, orgId, userId),
    collectAgentConfig(db, run.agentComposeVersionId),
    collectSessionRuns(db, runId, sessionId),
  ]);

  const sessionRunIds = sessionRuns.map((sessionRun) => {
    return sessionRun.id;
  });
  const [agentEvents, systemLogText, networkLogEntries] = await Promise.all([
    collectAgentEvents(get, sessionRuns),
    collectSystemLog(get, sessionRunIds),
    collectNetworkLog(get, sessionRunIds),
  ]);
  const promptEvents = buildPromptEvents(sessionRuns);
  const chatHistory = sortChatHistory(promptEvents, agentEvents);

  log.debug("Collected chat history for diagnostic bundle", {
    reference,
    runCount: sessionRunIds.length,
    eventCount: agentEvents.length,
    promptCount: promptEvents.length,
  });

  const activityLogs = await collectActivityLogs(get, sessionRuns, agentConfig);
  const zipEntries = buildZipEntries({
    reference,
    userId,
    orgId,
    runId,
    sessionId,
    title,
    description,
    chatHistory,
    run,
    safeConnectors: safeConnectorSummaries(connectors),
    agentConfig,
    activityLogs,
    systemLogText,
    networkLogEntries,
  });
  const { downloadUrl, expiresAt } = await uploadDiagnosticZip(get, {
    zipEntries,
    s3PathPrefix: params.s3PathPrefix,
    orgId,
    reference,
  });

  const [userEmail, orgName] = await Promise.all([
    resolveUserEmail(get, userId),
    resolveOrgName(get, orgId),
  ]);

  await createPlainSupportThread({
    userId,
    userEmail,
    orgId,
    orgName,
    runId,
    title,
    description,
    reference,
    downloadUrl,
    expiresAt,
    emailSubjectPrefix: params.emailSubjectPrefix,
  });

  log.debug("Diagnostic bundle submitted", { reference, runId, orgId });

  return { reference };
}

function getDb(get: ComputedGetter): ServiceDb {
  return get(db$);
}

async function collectConnectors(
  get: ComputedGetter,
  orgId: string,
  userId: string,
) {
  const response = await tapError(
    get(zeroConnectorList({ orgId, userId })),
    (error) => {
      log.warn("Failed to collect connectors", { error: String(error) });
    },
  );
  return response?.connectors ?? [];
}

function buildPromptEvents(
  sessionRuns: readonly DiagnosticRunRecord[],
): ChatHistoryEvent[] {
  return sessionRuns.map((sessionRun) => {
    return {
      runId: sessionRun.id,
      eventType: "user_prompt",
      sequenceNumber: -1,
      eventData: {
        type: "user_prompt",
        sequenceNumber: -1,
        role: "user",
        content: sessionRun.prompt,
      },
      _time: sessionRun.createdAt.toISOString(),
    };
  });
}

function sortChatHistory(
  promptEvents: readonly ChatHistoryEvent[],
  agentEvents: readonly ChatHistoryEvent[],
): ChatHistoryEvent[] {
  return [...promptEvents, ...agentEvents].sort((a, b) => {
    if (a._time !== b._time) {
      return a._time < b._time ? -1 : 1;
    }
    return a.sequenceNumber - b.sequenceNumber;
  });
}

function collectActivityLogs(
  get: ComputedGetter,
  sessionRuns: readonly DiagnosticRunRecord[],
  agentConfig: Record<string, unknown>,
): Promise<readonly unknown[]> {
  return Promise.all(
    sessionRuns.map(async (sessionRun) => {
      const settled = await settle(
        assembleActivityLog(get, sessionRun, agentConfig, {
          waitForAgentEventWatermark: false,
        }),
      );
      if (settled.ok) {
        return settled.value;
      }
      log.warn("Failed to assemble activity log for run", {
        runId: sessionRun.id,
        error: String(settled.error),
      });
      return {
        ok: false as const,
        error: String(settled.error),
        runId: sessionRun.id,
      };
    }),
  );
}

function safeConnectorSummaries(
  connectors: readonly {
    readonly type: unknown;
    readonly authMethod: unknown;
    readonly needsReconnect: unknown;
    readonly externalUsername: unknown;
  }[],
): Record<string, unknown>[] {
  return connectors.map((connector) => {
    return {
      type: connector.type,
      authMethod: connector.authMethod,
      needsReconnect: connector.needsReconnect,
      externalUsername: connector.externalUsername,
    };
  });
}

function jsonLines(values: readonly unknown[]): string {
  return values
    .map((value) => {
      return JSON.stringify(value);
    })
    .join("\n");
}

function buildZipEntries(params: ZipEntryParams): ZipEntry[] {
  const zipEntries: ZipEntry[] = [
    {
      path: "manifest.json",
      content: JSON.stringify(
        {
          reference: params.reference,
          userId: params.userId,
          orgId: params.orgId,
          runId: params.runId,
          sessionId: params.sessionId,
          createdAt: nowDate().toISOString(),
        },
        null,
        2,
      ),
    },
    {
      path: "description.md",
      content: params.description
        ? `# ${params.title}\n\n${params.description}`
        : `# ${params.title}`,
    },
    {
      path: "chat-history.jsonl",
      content: jsonLines(params.chatHistory),
    },
    {
      path: "environment.json",
      content: JSON.stringify(
        {
          runId: params.run.id,
          orgId: params.orgId,
          status: params.run.status,
          error: params.run.error,
          createdAt: params.run.createdAt.toISOString(),
          startedAt: params.run.startedAt?.toISOString() ?? null,
          completedAt: params.run.completedAt?.toISOString() ?? null,
          runnerGroup: params.run.runnerGroup,
        },
        null,
        2,
      ),
    },
    {
      path: "connectors.json",
      content: JSON.stringify(params.safeConnectors, null, 2),
    },
    {
      path: "agent-config.json",
      content: JSON.stringify(params.agentConfig, null, 2),
    },
    ...params.activityLogs.map((activityLog, index) => {
      return {
        path: `activity-log-${index}.json`,
        content: JSON.stringify(activityLog),
      };
    }),
  ];

  if (params.systemLogText) {
    zipEntries.push({
      path: "system-log.txt",
      content: params.systemLogText,
    });
  }

  if (params.networkLogEntries.length > 0) {
    zipEntries.push({
      path: "network-log.jsonl",
      content: jsonLines(params.networkLogEntries),
    });
  }

  return zipEntries;
}

async function uploadDiagnosticZip(
  get: ComputedGetter,
  params: {
    readonly zipEntries: readonly ZipEntry[];
    readonly s3PathPrefix: string;
    readonly orgId: string;
    readonly reference: string;
  },
): Promise<UploadResult> {
  const zipBuffer = await assembleZip(params.zipEntries);
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const s3Key = `${params.s3PathPrefix}/${params.orgId}/${params.reference}.zip`;
  await get(putS3Object(bucket, s3Key, zipBuffer, "application/zip"));

  const downloadUrl = await get(
    generatePresignedGetUrl(
      bucket,
      s3Key,
      DOWNLOAD_EXPIRY_SECONDS,
      "diagnostic-report.zip",
      true,
    ),
  );
  const expiresAt = new Date(
    now() + DOWNLOAD_EXPIRY_SECONDS * 1000,
  ).toISOString();

  return { downloadUrl, expiresAt };
}

async function collectAgentConfig(
  db: ServiceDb,
  agentComposeVersionId: string | null,
): Promise<Record<string, unknown>> {
  if (!agentComposeVersionId) {
    return {};
  }

  const [agent] = await db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      customSkills: zeroAgents.customSkills,
      permissionPolicies: zeroAgents.permissionPolicies,
      composeContent: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!agent) {
    return {};
  }

  return {
    displayName: agent.displayName,
    description: agent.description,
    sound: agent.sound,
    customSkills: agent.customSkills,
    permissionPolicies: agent.permissionPolicies,
    composeContent: agent.composeContent,
  };
}

function sessionRunSelect() {
  return {
    id: agentRuns.id,
    userId: agentRuns.userId,
    orgId: agentRuns.orgId,
    status: agentRuns.status,
    error: agentRuns.error,
    prompt: agentRuns.prompt,
    appendSystemPrompt: agentRuns.appendSystemPrompt,
    createdAt: agentRuns.createdAt,
    startedAt: agentRuns.startedAt,
    completedAt: agentRuns.completedAt,
    lastEventSequence: agentRuns.lastEventSequence,
    agentComposeVersionId: agentRuns.agentComposeVersionId,
    runnerGroup: agentRuns.runnerGroup,
    continuedFromSessionId: agentRuns.continuedFromSessionId,
    result: agentRuns.result,
  };
}

function collectSessionRuns(
  db: ServiceDb,
  runId: string,
  sessionId: string | null,
): Promise<DiagnosticRunRecord[]> {
  if (sessionId) {
    return db
      .select(sessionRunSelect())
      .from(agentRuns)
      .where(
        or(
          eq(agentRuns.continuedFromSessionId, sessionId),
          sql`${agentRuns.result}->>'agentSessionId' = ${sessionId}`,
        ),
      )
      .orderBy(agentRuns.createdAt);
  }

  return db
    .select(sessionRunSelect())
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
}

async function collectSystemLog(
  get: ComputedGetter,
  sessionRunIds: readonly string[],
): Promise<string> {
  if (sessionRunIds.length === 0) {
    return "";
  }

  const runIdList = sessionRunIds
    .map((id) => {
      return `"${escapeAplString(id)}"`;
    })
    .join(", ");
  const dataset = getDatasetName("sandbox-telemetry-system");
  const apl = `['${dataset}']
| where runId in (${runIdList})
| order by _time asc`;

  const queried = await settle(
    (async (): Promise<string> => {
      const events = (await get(queryAxiom(apl))) as { log: string }[];
      return events
        .map((event) => {
          return event.log;
        })
        .join("");
    })(),
  );
  if (!queried.ok) {
    log.warn("Failed to collect system log from Axiom", {
      error: String(queried.error),
    });
    return "";
  }
  return queried.value;
}

async function collectNetworkLog(
  get: ComputedGetter,
  sessionRunIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  if (sessionRunIds.length === 0) {
    return [];
  }

  const runIdList = sessionRunIds
    .map((id) => {
      return `"${escapeAplString(id)}"`;
    })
    .join(", ");
  const dataset = getDatasetName("sandbox-telemetry-network");
  const apl = `['${dataset}']
| where runId in (${runIdList})
| order by _time asc`;

  const queried = await settle(
    (async (): Promise<Record<string, unknown>[]> => {
      return (await get(queryAxiom(apl))) as Record<string, unknown>[];
    })(),
  );
  if (!queried.ok) {
    log.warn("Failed to collect network log from Axiom", {
      error: String(queried.error),
    });
    return [];
  }
  return queried.value;
}

async function collectAgentEvents(
  get: ComputedGetter,
  sessionRuns: readonly RunMeta[],
): Promise<ChatHistoryEvent[]> {
  const sessionRunIds = sessionRuns.map((run) => {
    return run.id;
  });
  if (sessionRunIds.length === 0) {
    return [];
  }

  const terminalRuns = sessionRuns.filter((run) => {
    return run.lastEventSequence !== null;
  });
  if (terminalRuns.length > 0) {
    await waitForAgentEventWatermarks(terminalRuns);
  }

  const runIdList = sessionRunIds
    .map((id) => {
      return `"${escapeAplString(id)}"`;
    })
    .join(", ");
  const dataset = getDatasetName("agent-run-events");
  const apl = `['${dataset}']
| where runId in (${runIdList})
| order by _time asc, sequenceNumber asc
| limit 2000`;

  const queried = await settle(
    (async (): Promise<ChatHistoryEvent[]> => {
      const events = (await get(
        queryAxiom(apl, { noCache: true }),
      )) as unknown as readonly ChatHistoryEvent[];
      return [...events];
    })(),
  );
  if (!queried.ok) {
    log.warn("Failed to collect agent events from Axiom", {
      error: String(queried.error),
    });
    return [];
  }
  return queried.value;
}

async function waitForAgentEventWatermarks(
  terminalRuns: readonly RunMeta[],
): Promise<void> {
  for (
    let offset = 0;
    offset < terminalRuns.length;
    offset += AGENT_EVENT_WATERMARK_WAIT_CONCURRENCY
  ) {
    const batch = terminalRuns.slice(
      offset,
      offset + AGENT_EVENT_WATERMARK_WAIT_CONCURRENCY,
    );
    await Promise.all(
      batch.map((run) => {
        return waitForRunEventWatermarkVisible(run.id, run.lastEventSequence);
      }),
    );
  }
}

interface AssembleActivityLogOptions {
  readonly waitForAgentEventWatermark?: boolean;
}

async function assembleActivityLog(
  get: ComputedGetter,
  run: RunMeta,
  agent: AgentMeta,
  options: AssembleActivityLogOptions = {},
): Promise<Record<string, unknown>> {
  const waitForAgentEventWatermark = options.waitForAgentEventWatermark ?? true;
  const [events, networkLogs, runContext] = await Promise.all([
    queryAgentEvents(
      get,
      run.id,
      run.lastEventSequence,
      waitForAgentEventWatermark,
    ),
    queryNetworkLogs(get, run.id),
    tapError(queryRunContext(get, run.id), (error) => {
      log.warn("Failed to collect run context", { error: String(error) });
    }),
  ]);

  const data: Record<string, unknown> = {
    meta: buildMeta(run, agent),
    events: events.map((event) => {
      return {
        sequenceNumber: event.sequenceNumber,
        eventType: event.eventType,
        eventData: event.eventData,
        createdAt: event._time,
      };
    }),
  };

  if (runContext) {
    data.context = runContext;
  }
  if (networkLogs.length > 0) {
    data.networkLogs = mapNetworkLogs(networkLogs);
  }

  return data;
}

function buildMeta(run: RunMeta, agent: AgentMeta): Record<string, unknown> {
  const agentConfig = extractAgentConfig(agent.composeContent);

  return {
    id: run.id,
    displayName: agent.displayName ?? null,
    status: run.status,
    modelProvider: agentConfig?.modelProvider ?? null,
    selectedModel: agentConfig?.selectedModel ?? null,
    framework: agentConfig?.framework ?? null,
    prompt: run.prompt,
    appendSystemPrompt: run.appendSystemPrompt,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    sessionId: runSessionId(run),
    runnerGroup: run.runnerGroup,
  };
}

function extractAgentConfig(composeContent: unknown): AgentConfigShape | null {
  const compose = composeContent as {
    readonly agent?: AgentConfigShape;
    readonly agents?: Record<string, AgentConfigShape>;
  } | null;

  if (compose?.agent) {
    return compose.agent;
  }

  const firstAgent = compose?.agents ? Object.values(compose.agents)[0] : null;
  return firstAgent ?? null;
}

function runSessionId(run: RunMeta): string | null {
  const resultObject = run.result as {
    readonly agentSessionId?: string;
  } | null;
  return resultObject?.agentSessionId ?? run.continuedFromSessionId ?? null;
}

function mapNetworkLogs(
  logs: readonly AxiomNetworkEvent[],
): Record<string, unknown>[] {
  return logs.map((event) => {
    return {
      timestamp: event._time,
      type: event.type,
      action: event.action,
      host: event.host,
      port: event.port,
      method: event.method,
      url: event.url,
      status: event.status,
      latency_ms: event.latency_ms,
      request_size: event.request_size,
      response_size: event.response_size,
      dns_event: event.dns_event,
      dns_query_type: event.dns_query_type,
      dns_result: event.dns_result,
      dns_serial: event.dns_serial,
      firewall_base: event.firewall_base,
      firewall_name: event.firewall_name,
      firewall_permission: event.firewall_permission,
      firewall_rule_match: event.firewall_rule_match,
      firewall_params: event.firewall_params,
      firewall_billable: event.firewall_billable,
      firewall_error: event.firewall_error,
      auth_resolved_secrets: event.auth_resolved_secrets,
      auth_refreshed_connectors: event.auth_refreshed_connectors,
      auth_refreshed_secrets: event.auth_refreshed_secrets,
      auth_cache_hit: event.auth_cache_hit,
      auth_url_rewrite: event.auth_url_rewrite,
      error: event.error,
      request_headers: event.request_headers,
      request_body: event.request_body,
      request_body_encoding: event.request_body_encoding,
      request_body_truncated: event.request_body_truncated,
      response_headers: event.response_headers,
      response_body: event.response_body,
      response_body_encoding: event.response_body_encoding,
      response_body_truncated: event.response_body_truncated,
    };
  });
}

async function queryAgentEvents(
  get: ComputedGetter,
  runId: string,
  lastEventSequence: number | null,
  waitForAgentEventWatermark: boolean,
): Promise<AxiomAgentEvent[]> {
  if (waitForAgentEventWatermark && lastEventSequence !== null) {
    await waitForRunEventWatermarkVisible(runId, lastEventSequence);
  }

  const dataset = getDatasetName("agent-run-events");
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| order by _time asc, sequenceNumber asc
| limit 5000`;

  const queried = await settle(
    (async (): Promise<AxiomAgentEvent[]> => {
      const events = (await get(
        queryAxiom(apl, {
          noCache: true,
        }),
      )) as unknown as readonly AxiomAgentEvent[];
      return [...events];
    })(),
  );
  if (!queried.ok) {
    log.warn("Failed to collect agent telemetry", {
      error: String(queried.error),
    });
    return [];
  }
  return queried.value;
}

async function queryNetworkLogs(
  get: ComputedGetter,
  runId: string,
): Promise<AxiomNetworkEvent[]> {
  const dataset = getDatasetName("sandbox-telemetry-network");
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| order by _time asc
| limit 5000`;

  const queried = await settle(
    (async (): Promise<AxiomNetworkEvent[]> => {
      return (await get(queryAxiom(apl))) as AxiomNetworkEvent[];
    })(),
  );
  if (!queried.ok) {
    log.warn("Failed to collect network logs", {
      error: String(queried.error),
    });
    return [];
  }
  return queried.value;
}

async function queryRunContext(
  get: ComputedGetter,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const dataset = getDatasetName("run-context");
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| limit 1`;

  const results = (await get(queryAxiom(apl))) as Record<string, unknown>[];
  return results[0] ?? null;
}

interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkEmailProfile {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string | null;
}

function primaryEmail(user: ClerkEmailProfile): string | null {
  const email = user.emailAddresses.find((candidate) => {
    return candidate.id === user.primaryEmailAddressId;
  });
  return email?.emailAddress ?? null;
}

async function resolveUserEmail(
  get: ComputedGetter,
  userId: string,
): Promise<string> {
  const result = await settle(
    (async (): Promise<string> => {
      const client = get(clerk$);
      const users = await client.users.getUserList({ userId: [userId] });
      const user = users.data.find((candidate: ClerkEmailProfile) => {
        return candidate.id === userId;
      });
      return user ? (primaryEmail(user) ?? userId) : userId;
    })(),
  );
  if (!result.ok) {
    return userId;
  }
  return result.value;
}

async function resolveOrgName(
  get: ComputedGetter,
  orgId: string,
): Promise<string> {
  const result = await settle(
    (async (): Promise<string> => {
      const client = get(clerk$);
      const org = await client.organizations.getOrganization({
        organizationId: orgId,
      });
      return org.name;
    })(),
  );
  if (!result.ok) {
    return orgId;
  }
  return result.value;
}
