import { createHmac, hkdfSync } from "crypto";
import archiver from "archiver";
import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroDeveloperSupportContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { eq } from "drizzle-orm";
import { getSessionChatMessages } from "../../../../src/lib/zero/zero-session-service";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import {
  uploadS3Buffer,
  generatePresignedUrl,
} from "../../../../src/lib/infra/s3/s3-client";
import { enqueueEmail } from "../../../../src/lib/zero/email/outbox-service";
import { buildFromAddress } from "../../../../src/lib/zero/email/handlers/shared";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:developer-support");

const DOWNLOAD_EXPIRY_SECONDS = 72 * 60 * 60;

// Cache the derived HMAC key for the process lifetime
let cachedConsentKey: Buffer | null = null;

function getConsentKey(): Buffer {
  if (!cachedConsentKey) {
    const keyHex = env().SECRETS_ENCRYPTION_KEY;
    const masterKey = Buffer.from(keyHex, "hex");
    cachedConsentKey = Buffer.from(
      hkdfSync("sha256", masterKey, "", "developer-support-consent", 32),
    );
  }
  return cachedConsentKey;
}

function generateConsentCode(runId: string): string {
  const key = getConsentKey();
  return createHmac("sha256", key)
    .update(runId)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
}

interface ZipEntry {
  path: string;
  content: string;
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

const router = tsr.router(zeroDeveloperSupportContract, {
  submit: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "developer-support:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { userId, orgId, runId } = authCtx;
    if (!runId || !orgId) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "This endpoint requires a zero token with runId and orgId",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    // Step 1: Generate consent code if none provided
    if (!body.consentCode) {
      const consentCode = generateConsentCode(runId);
      return {
        status: 200 as const,
        body: { consentCode },
      };
    }

    // Step 2: Validate consent code
    const expectedCode = generateConsentCode(runId);
    if (body.consentCode !== expectedCode) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Invalid consent code",
            code: "INVALID_CONSENT_CODE",
          },
        },
      };
    }

    const reference = `ds-${crypto.randomUUID().slice(0, 8)}`;
    const db = globalThis.services.db;

    // Collect data in parallel
    const [run, connectors] = await Promise.all([
      db
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          createdAt: agentRuns.createdAt,
          startedAt: agentRuns.startedAt,
          completedAt: agentRuns.completedAt,
          agentComposeVersionId: agentRuns.agentComposeVersionId,
          runnerGroup: agentRuns.runnerGroup,
          continuedFromSessionId: agentRuns.continuedFromSessionId,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1)
        .then((rows) => {
          return rows[0] ?? null;
        }),
      listConnectors(orgId, userId).catch((err) => {
        log.warn("Failed to collect connectors", { error: String(err) });
        return [];
      }),
    ]);

    if (!run) {
      return {
        status: 400 as const,
        body: {
          error: { message: "Run not found", code: "RUN_NOT_FOUND" },
        },
      };
    }

    // Collect agent config via compose version join
    let agentConfig: Record<string, unknown> = {};
    if (run.agentComposeVersionId) {
      const [agent] = await db
        .select({
          displayName: zeroAgents.displayName,
          description: zeroAgents.description,
          sound: zeroAgents.sound,
          customSkills: zeroAgents.customSkills,
          firewallPolicies: zeroAgents.firewallPolicies,
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
          firewallPolicies: agent.firewallPolicies,
        };
      }
    }

    // Collect session messages if available
    let conversation: unknown[] = [];
    const sessionId = run.continuedFromSessionId;
    if (sessionId) {
      conversation = await getSessionChatMessages(sessionId);
    }

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
            sessionId: sessionId ?? null,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      },
      {
        path: "description.md",
        content: `# ${body.title}\n\n${body.description}`,
      },
      {
        path: "conversation.json",
        content: JSON.stringify(conversation, null, 2),
      },
      {
        path: "environment.json",
        content: JSON.stringify(
          {
            runId: run.id,
            orgId,
            status: run.status,
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
    const s3Key = `developer-support/${orgId}/${reference}.zip`;
    await uploadS3Buffer(bucket, s3Key, zipBuffer, "application/zip");

    const downloadUrl = await generatePresignedUrl(
      bucket,
      s3Key,
      DOWNLOAD_EXPIRY_SECONDS,
      "developer-support.zip",
      true,
    );

    const expiresAt = new Date(
      Date.now() + DOWNLOAD_EXPIRY_SECONDS * 1000,
    ).toISOString();

    // Send email notification
    await enqueueEmail({
      from: buildFromAddress("vm0"),
      to: "contact@vm0.ai",
      subject: `[Developer Support] ${body.title}`,
      template: {
        template: "developer-support",
        props: {
          title: body.title,
          description: body.description,
          reference,
          userId,
          orgId,
          runId,
          downloadUrl,
          expiresAt,
        },
      },
    });

    log.info("Developer support bundle submitted", { reference, runId, orgId });

    return {
      status: 200 as const,
      body: { reference },
    };
  },
});

const handler = createHandler(zeroDeveloperSupportContract, router);

export { handler as POST };
