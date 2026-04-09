import archiver from "archiver";
import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroReportErrorContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { eq, or, sql } from "drizzle-orm";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../src/lib/shared/axiom";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import {
  uploadS3Buffer,
  generatePresignedUrl,
} from "../../../../src/lib/infra/s3/s3-client";
import { enqueueEmail } from "../../../../src/lib/zero/email/outbox-service";
import { buildFromAddress } from "../../../../src/lib/zero/email/handlers/shared";
import { getCachedUser } from "../../../../src/lib/auth/user-cache-service";
import { getOrgNameAndSlug } from "../../../../src/lib/auth/org-cache";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:report-error");

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

const router = tsr.router(zeroReportErrorContract, {
  submit: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { userId } = authCtx;
    const { org } = await resolveOrg(authCtx);
    const orgId = org.orgId;

    const db = globalThis.services.db;
    const runId = body.runId;

    // Query run record and verify ownership
    const [run] = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        error: agentRuns.error,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        runnerGroup: agentRuns.runnerGroup,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        orgId: agentRuns.orgId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return {
        status: 400 as const,
        body: {
          error: { message: "Run not found", code: "RUN_NOT_FOUND" },
        },
      };
    }

    if (run.orgId !== orgId) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Run does not belong to this organization",
            code: "FORBIDDEN",
          },
        },
      };
    }

    if (run.status !== "failed") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Only failed runs can be reported",
            code: "RUN_NOT_FAILED",
          },
        },
      };
    }

    const reference = `er-${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = run.continuedFromSessionId;

    // Collect connectors (sanitized)
    const connectors = await listConnectors(orgId, userId).catch((err) => {
      log.warn("Failed to collect connectors", { error: String(err) });
      return [];
    });

    // Collect agent config
    let agentConfig: Record<string, unknown> = {};
    if (run.agentComposeVersionId) {
      const [agent] = await db
        .select({
          displayName: zeroAgents.displayName,
          description: zeroAgents.description,
          sound: zeroAgents.sound,
          customSkills: zeroAgents.customSkills,
          permissionPolicies: zeroAgents.permissionPolicies,
        })
        .from(agentComposeVersions)
        .innerJoin(
          agentComposes,
          eq(agentComposeVersions.composeId, agentComposes.id),
        )
        .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
        .where(eq(agentComposeVersions.id, run.agentComposeVersionId))
        .limit(1);

      if (agent) {
        agentConfig = {
          displayName: agent.displayName,
          description: agent.description,
          sound: agent.sound,
          customSkills: agent.customSkills,
          permissionPolicies: agent.permissionPolicies,
        };
      }
    }

    // Collect session runs for chat history
    const sessionRuns = sessionId
      ? await db
          .select({
            id: agentRuns.id,
            prompt: agentRuns.prompt,
            createdAt: agentRuns.createdAt,
          })
          .from(agentRuns)
          .where(
            or(
              eq(agentRuns.continuedFromSessionId, sessionId),
              sql`${agentRuns.result}->>'agentSessionId' = ${sessionId}`,
            ),
          )
          .orderBy(agentRuns.createdAt)
      : await db
          .select({
            id: agentRuns.id,
            prompt: agentRuns.prompt,
            createdAt: agentRuns.createdAt,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1);

    // Query Axiom for agent events
    const sessionRunIds = sessionRuns.map((r) => {
      return r.id;
    });
    const agentEvents = await (async () => {
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
      return queryAxiom<ChatHistoryEvent>(apl);
    })().catch((err) => {
      log.warn("Failed to collect agent events from Axiom", {
        error: String(err),
      });
      return [] as ChatHistoryEvent[];
    });

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

    log.info("Collected chat history for error report", {
      reference,
      runCount: sessionRunIds.length,
      eventCount: agentEvents.length,
      promptCount: promptEvents.length,
    });

    // Safe connector subset (no tokens)
    const safeConnectors = connectors.map((c) => {
      return {
        type: c.type,
        authMethod: c.authMethod,
        needsReconnect: c.needsReconnect,
        externalUsername: c.externalUsername,
      };
    });

    const title = `Run failed: ${run.error ?? "Unknown error"}`;
    const description = `Automatic error report submitted by user for run ${runId}.`;

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
        content: `# ${title}\n\n${description}`,
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
    ];

    const zipBuffer = await assembleZip(zipEntries);

    // Upload to R2
    const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
    const s3Key = `error-reports/${orgId}/${reference}.zip`;
    await uploadS3Buffer(bucket, s3Key, zipBuffer, "application/zip");

    const downloadUrl = await generatePresignedUrl(
      bucket,
      s3Key,
      DOWNLOAD_EXPIRY_SECONDS,
      "error-report.zip",
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

    // Send email notification (reuse developer-support template)
    await enqueueEmail({
      from: buildFromAddress("vm0"),
      to: "contact@vm0.ai",
      subject: `[Error Report] Run failed - ${runId}`,
      template: {
        template: "developer-support",
        props: {
          title,
          description,
          reference,
          userId,
          userEmail,
          orgId,
          orgName,
          runId,
          downloadUrl,
          expiresAt,
        },
      },
    });

    log.info("Error report submitted", { reference, runId, orgId });

    return {
      status: 200 as const,
      body: { reference },
    };
  },
});

const handler = createHandler(zeroReportErrorContract, router);

export { handler as POST };
