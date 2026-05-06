import archiver from "archiver";
import { eq, or, sql } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { queryAxiom, getDatasetName, DATASETS } from "../../shared/axiom";
import {
  assembleActivityLog,
  type RunMeta,
} from "../../infra/run/activity-log-service";
import { listConnectors } from "../connector/connector-service";
import { uploadS3Buffer, generatePresignedUrl } from "../../infra/s3/s3-client";
import { createPlainSupportThread } from "./plain-service";
import { getCachedUser } from "../../auth/user-cache-service";
import { getOrgNameAndSlug } from "../../auth/org-cache";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("service:diagnostic-bundle");

const DOWNLOAD_EXPIRY_SECONDS = 72 * 60 * 60;

interface ZipEntry {
  path: string;
  content: string;
}

interface ChatHistoryEvent {
  runId: string;
  eventType: string;
  sequenceNumber: number;
  eventData: Record<string, unknown>;
  _time: string;
}

interface DiagnosticRunRecord extends RunMeta {
  agentComposeVersionId: string | null;
}

interface DiagnosticBundleParams {
  title: string;
  description?: string;
  userId: string;
  orgId: string;
  runId: string;
  run: DiagnosticRunRecord;
  /** Prefix for the reference ID, e.g. "er" or "ds" */
  referencePrefix: string;
  /** S3 path prefix, e.g. "error-reports" or "developer-support" */
  s3PathPrefix: string;
  /** Email subject prefix, e.g. "[Error Report]" or "[Developer Support]" */
  emailSubjectPrefix: string;
}

interface DiagnosticBundleResult {
  reference: string;
}

async function assembleZip(entries: ZipEntry[]): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];

  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => {
      return chunks.push(chunk);
    });
    archive.on("end", () => {
      return resolve(Buffer.concat(chunks));
    });
    archive.on("error", reject);
  });

  for (const entry of entries) {
    archive.append(Buffer.from(entry.content), { name: entry.path });
  }

  await archive.finalize();
  return done;
}

/**
 * Assemble and submit a diagnostic bundle (ZIP with chat history, activity log,
 * environment, connectors, agent config), upload to S3, and send email.
 *
 * Shared by report-error (web auth) and developer-support (sandbox token auth).
 */
export async function submitDiagnosticBundle(
  params: DiagnosticBundleParams,
): Promise<DiagnosticBundleResult> {
  const { title, description, userId, orgId, runId, run } = params;
  const reference = `${params.referencePrefix}-${crypto.randomUUID().slice(0, 8)}`;
  const sessionId = run.continuedFromSessionId;
  const db = globalThis.services.db;

  // Collect connectors (sanitized), agent config, and chat history in parallel
  const [connectors, agentConfig, sessionRuns] = await Promise.all([
    listConnectors(orgId, userId).catch((err) => {
      log.warn("Failed to collect connectors", { error: String(err) });
      return [];
    }),
    collectAgentConfig(db, run.agentComposeVersionId),
    collectSessionRuns(db, runId, sessionId),
  ]);

  // Query Axiom for agent events, system log, and network log in parallel
  const sessionRunIds = sessionRuns.map((r) => {
    return r.id;
  });
  const [agentEvents, systemLogText, networkLogEntries] = await Promise.all([
    collectAgentEvents(sessionRunIds),
    collectSystemLog(sessionRunIds),
    collectNetworkLog(sessionRunIds),
  ]);

  // Synthesize user_prompt events
  const promptEvents: ChatHistoryEvent[] = sessionRuns.map((r) => {
    return {
      runId: r.id,
      eventType: "user_prompt",
      sequenceNumber: -1,
      eventData: {
        type: "user_prompt",
        sequenceNumber: -1,
        role: "user",
        content: r.prompt,
      },
      _time: r.createdAt.toISOString(),
    };
  });

  const chatHistory = [...promptEvents, ...agentEvents].sort((a, b) => {
    if (a._time !== b._time) return a._time < b._time ? -1 : 1;
    return a.sequenceNumber - b.sequenceNumber;
  });

  log.info("Collected chat history for diagnostic bundle", {
    reference,
    runCount: sessionRunIds.length,
    eventCount: agentEvents.length,
    promptCount: promptEvents.length,
  });

  // Assemble activity logs for all session runs. Isolate per-run failures so
  // one bad run (e.g. missing axiom events, stale schema) does not block the
  // entire diagnostic bundle submit.
  const activityLogs = await Promise.all(
    sessionRuns.map((r) => {
      return assembleActivityLog(r.id, r, agentConfig).catch((err) => {
        log.warn("Failed to assemble activity log for run", {
          runId: r.id,
          error: String(err),
        });
        return { ok: false as const, error: String(err), runId: r.id };
      });
    }),
  );

  // Safe connector subset (no tokens)
  const safeConnectors = connectors.map((c) => {
    return {
      type: c.type,
      authMethod: c.authMethod,
      needsReconnect: c.needsReconnect,
      externalUsername: c.externalUsername,
    };
  });

  // Assemble ZIP
  const zipEntries: ZipEntry[] = [
    {
      path: "manifest.json",
      content: JSON.stringify(
        {
          reference,
          userId,
          orgId,
          runId,
          sessionId,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    },
    {
      path: "description.md",
      content: description ? `# ${title}\n\n${description}` : `# ${title}`,
    },
    {
      path: "chat-history.jsonl",
      content: chatHistory
        .map((e) => {
          return JSON.stringify(e);
        })
        .join("\n"),
    },
    {
      path: "environment.json",
      content: JSON.stringify(
        {
          runId: run.id,
          orgId,
          status: run.status,
          error: run.error,
          createdAt: run.createdAt?.toISOString() ?? null,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
          runnerGroup: run.runnerGroup,
        },
        null,
        2,
      ),
    },
    {
      path: "connectors.json",
      content: JSON.stringify(safeConnectors, null, 2),
    },
    {
      path: "agent-config.json",
      content: JSON.stringify(agentConfig, null, 2),
    },
    ...activityLogs.map((al, i) => {
      return {
        path: `activity-log-${i}.json`,
        content: JSON.stringify(al),
      };
    }),
  ];

  if (systemLogText) {
    zipEntries.push({ path: "system-log.txt", content: systemLogText });
  }

  if (networkLogEntries.length > 0) {
    zipEntries.push({
      path: "network-log.jsonl",
      content: networkLogEntries
        .map((e) => {
          return JSON.stringify(e);
        })
        .join("\n"),
    });
  }

  const zipBuffer = await assembleZip(zipEntries);

  // Upload to R2
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const s3Key = `${params.s3PathPrefix}/${orgId}/${reference}.zip`;
  await uploadS3Buffer(bucket, s3Key, zipBuffer, "application/zip");

  const downloadUrl = await generatePresignedUrl(
    bucket,
    s3Key,
    DOWNLOAD_EXPIRY_SECONDS,
    "diagnostic-report.zip",
    true,
  );

  const expiresAt = new Date(
    Date.now() + DOWNLOAD_EXPIRY_SECONDS * 1000,
  ).toISOString();

  // Resolve user/org info for the email
  const [userEmail, orgName] = await Promise.all([
    getCachedUser(userId)
      .then((u) => {
        return u.email;
      })
      .catch(() => {
        return userId;
      }),
    getOrgNameAndSlug(orgId)
      .then((o) => {
        return o.name;
      })
      .catch(() => {
        return orgId;
      }),
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

  log.info("Diagnostic bundle submitted", { reference, runId, orgId });

  return { reference };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function collectAgentConfig(
  db: typeof globalThis.services.db,
  agentComposeVersionId: string | null,
): Promise<Record<string, unknown>> {
  if (!agentComposeVersionId) return {};

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

  if (!agent) return {};

  return {
    displayName: agent.displayName,
    description: agent.description,
    sound: agent.sound,
    customSkills: agent.customSkills,
    permissionPolicies: agent.permissionPolicies,
    composeContent: agent.composeContent,
  };
}

const sessionRunSelect = {
  id: agentRuns.id,
  status: agentRuns.status,
  error: agentRuns.error,
  prompt: agentRuns.prompt,
  appendSystemPrompt: agentRuns.appendSystemPrompt,
  createdAt: agentRuns.createdAt,
  startedAt: agentRuns.startedAt,
  completedAt: agentRuns.completedAt,
  runnerGroup: agentRuns.runnerGroup,
  continuedFromSessionId: agentRuns.continuedFromSessionId,
  result: agentRuns.result,
};

async function collectSessionRuns(
  db: typeof globalThis.services.db,
  runId: string,
  sessionId: string | null,
): Promise<RunMeta[]> {
  if (sessionId) {
    return db
      .select(sessionRunSelect)
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
    .select(sessionRunSelect)
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
}

async function collectSystemLog(sessionRunIds: string[]): Promise<string> {
  if (sessionRunIds.length === 0) return "";
  const runIdList = sessionRunIds
    .map((id) => {
      return `"${id}"`;
    })
    .join(", ");
  const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_SYSTEM);
  const apl = `['${dataset}']
| where runId in (${runIdList})
| order by _time asc`;
  const events = await queryAxiom<{ log: string }>(apl).catch((err) => {
    log.warn("Failed to collect system log from Axiom", {
      error: String(err),
    });
    return [] as { log: string }[];
  });
  return events
    .map((e) => {
      return e.log;
    })
    .join("");
}

async function collectNetworkLog(
  sessionRunIds: string[],
): Promise<Record<string, unknown>[]> {
  if (sessionRunIds.length === 0) return [];
  const runIdList = sessionRunIds
    .map((id) => {
      return `"${id}"`;
    })
    .join(", ");
  const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
  const apl = `['${dataset}']
| where runId in (${runIdList})
| order by _time asc`;
  // [NETWORK_LOG_FIELDS] — diagnostic bundle keeps raw Axiom network events
  // unprojected so newly added fields are included automatically.
  return queryAxiom<Record<string, unknown>>(apl).catch((err) => {
    log.warn("Failed to collect network log from Axiom", {
      error: String(err),
    });
    return [] as Record<string, unknown>[];
  });
}

async function collectAgentEvents(
  sessionRunIds: string[],
): Promise<ChatHistoryEvent[]> {
  if (sessionRunIds.length === 0) return [];
  const runIdList = sessionRunIds
    .map((id) => {
      return `"${id}"`;
    })
    .join(", ");
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId in (${runIdList})
| order by _time asc, sequenceNumber asc
| limit 2000`;
  return queryAxiom<ChatHistoryEvent>(apl).catch((err) => {
    log.warn("Failed to collect agent events from Axiom", {
      error: String(err),
    });
    return [] as ChatHistoryEvent[];
  });
}
