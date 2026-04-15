import { eq, and, inArray } from "drizzle-orm";
import archiver from "archiver";
import { exportJobs } from "../../../db/schema/export-job";
import type { ExportArtifactUrl } from "../../../db/schema/export-job";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { conversations } from "../../../db/schema/conversation";
import { storages, storageVersions } from "../../../db/schema/storage";
import {
  uploadS3Buffer,
  generatePresignedUrl,
  downloadS3Buffer,
} from "../../infra/s3/s3-client";
import { getAllSessionsWithMessages } from "../zero-session-service";
import { chatThreads } from "../../../db/schema/chat-thread";
import { chatMessages } from "../../../db/schema/chat-message";
import { resolveSessionHistory } from "../../infra/session-history/session-history-service";
import { enqueueEmail } from "../email/outbox-service";
import {
  buildFromAddress,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from "../email/handlers/shared";
import { isUserUnsubscribed } from "../email/unsubscribe-service";
import { getCachedUser } from "../../auth/user-cache-service";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("export");

// 72 hours in seconds and milliseconds
const DOWNLOAD_EXPIRY_SECONDS = 72 * 60 * 60;
const DOWNLOAD_EXPIRY_MS = DOWNLOAD_EXPIRY_SECONDS * 1000;

interface ZipEntry {
  path: string;
  content: Buffer | string;
}

interface CollectedData {
  zipEntries: ZipEntry[];
  artifactUrls: ExportArtifactUrl[];
  instructionCount: number;
  conversationCount: number;
}

/**
 * Collect instructions (compose configs and R2 archives) for the user.
 */
async function collectInstructions(
  userId: string,
  orgId: string,
  bucket: string,
): Promise<{ entries: ZipEntry[]; count: number }> {
  const db = globalThis.services.db;
  const entries: ZipEntry[] = [];
  let count = 0;

  const composes = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(
      and(eq(agentComposes.userId, userId), eq(agentComposes.orgId, orgId)),
    );

  for (const compose of composes) {
    if (!compose.headVersionId) continue;

    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (version) {
      entries.push({
        path: `instructions/${compose.name}/vm0.yaml`,
        content: JSON.stringify(version.content, null, 2),
      });
      count++;
    }

    // Try to download instructions file from R2
    const instructionsStorageName = `agent-instructions@${compose.name}`;
    const [instructionsStorage] = await db
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, orgId),
          eq(storages.name, instructionsStorageName),
          eq(storages.type, "volume"),
        ),
      )
      .limit(1);

    if (instructionsStorage?.headVersionId) {
      const [sv] = await db
        .select({ s3Key: storageVersions.s3Key })
        .from(storageVersions)
        .where(eq(storageVersions.id, instructionsStorage.headVersionId))
        .limit(1);

      if (sv) {
        const archiveKey = `${sv.s3Key}/archive.tar.gz`;
        const archiveBuffer = await downloadS3Buffer(bucket, archiveKey);
        entries.push({
          path: `instructions/${compose.name}/instructions.tar.gz`,
          content: archiveBuffer,
        });
      }
    }
  }

  return { entries, count };
}

/**
 * Collect chat messages and CLI session history for the user.
 */
async function collectConversations(
  userId: string,
): Promise<{ entries: ZipEntry[]; count: number }> {
  const db = globalThis.services.db;
  const entries: ZipEntry[] = [];
  let count = 0;

  // Export chat thread messages from chat_messages table
  const threads = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId));

  for (const thread of threads) {
    const messages = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        runId: chatMessages.runId,
        error: chatMessages.error,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, thread.id))
      .orderBy(chatMessages.createdAt);

    if (messages.length > 0) {
      entries.push({
        path: `conversations/chat-thread-${thread.id}.json`,
        content: JSON.stringify(messages, null, 2),
      });
      count++;
    }
  }

  // Export other channel sessions (Slack, Email, Telegram) from JSONB
  const sessions = await getAllSessionsWithMessages(userId);

  for (const session of sessions) {
    if (session.chatMessages.length > 0) {
      entries.push({
        path: `conversations/${session.id}.json`,
        content: JSON.stringify(session.chatMessages, null, 2),
      });
      count++;
    }

    if (session.conversationId) {
      const [conv] = await db
        .select({
          cliAgentSessionHistoryHash: conversations.cliAgentSessionHistoryHash,
          cliAgentSessionHistory: conversations.cliAgentSessionHistory,
        })
        .from(conversations)
        .where(eq(conversations.id, session.conversationId))
        .limit(1);

      if (conv) {
        const history = await resolveSessionHistory(
          conv.cliAgentSessionHistoryHash,
          conv.cliAgentSessionHistory,
        );

        if (history) {
          entries.push({
            path: `conversations/${session.id}-history.jsonl`,
            content: history,
          });
        }
      }
    }
  }

  return { entries, count };
}

/**
 * Generate presigned URLs for artifact storages owned by the user.
 */
async function collectArtifacts(
  userId: string,
  orgId: string,
  bucket: string,
  expiresAtDate: Date,
): Promise<ExportArtifactUrl[]> {
  const db = globalThis.services.db;

  const artifactStorages = await db
    .select({
      id: storages.id,
      name: storages.name,
      headVersionId: storages.headVersionId,
      fileCount: storages.fileCount,
      size: storages.size,
    })
    .from(storages)
    .where(
      and(
        eq(storages.userId, userId),
        eq(storages.orgId, orgId),
        eq(storages.type, "artifact"),
      ),
    );

  const artifactUrls: ExportArtifactUrl[] = [];

  for (const artifact of artifactStorages) {
    if (!artifact.headVersionId || artifact.fileCount === 0) continue;

    const [sv] = await db
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(eq(storageVersions.id, artifact.headVersionId))
      .limit(1);

    if (sv) {
      const archiveKey = `${sv.s3Key}/archive.tar.gz`;
      const presignedUrl = await generatePresignedUrl(
        bucket,
        archiveKey,
        DOWNLOAD_EXPIRY_SECONDS,
        `${artifact.name}.tar.gz`,
        true,
      );

      artifactUrls.push({
        name: artifact.name,
        downloadUrl: presignedUrl,
        expiresAt: expiresAtDate.toISOString(),
      });
    }
  }

  return artifactUrls;
}

/**
 * Collect all user data into zip entries and artifact URLs.
 */
async function collectUserData(
  userId: string,
  orgId: string,
  bucket: string,
): Promise<CollectedData> {
  const zipEntries: ZipEntry[] = [];
  const expiresAtDate = new Date(Date.now() + DOWNLOAD_EXPIRY_MS);

  const instructions = await collectInstructions(userId, orgId, bucket);
  zipEntries.push(...instructions.entries);

  const convos = await collectConversations(userId);
  zipEntries.push(...convos.entries);

  const artifactUrls = await collectArtifacts(
    userId,
    orgId,
    bucket,
    expiresAtDate,
  );

  if (artifactUrls.length > 0) {
    zipEntries.push({
      path: "artifacts-manifest.json",
      content: JSON.stringify(artifactUrls, null, 2),
    });
  }

  zipEntries.push({
    path: "export-manifest.json",
    content: JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        userId,
        orgId,
        counts: {
          instructions: instructions.count,
          conversations: convos.count,
          artifacts: artifactUrls.length,
        },
      },
      null,
      2,
    ),
  });

  return {
    zipEntries,
    artifactUrls,
    instructionCount: instructions.count,
    conversationCount: convos.count,
  };
}

/**
 * Execute a GDPR data export job.
 * Collects user data, assembles a ZIP, uploads to R2, and sends email notification.
 */
export async function executeExportJob(
  jobId: string,
  userId: string,
  orgId: string,
): Promise<void> {
  const db = globalThis.services.db;
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

  try {
    await db
      .update(exportJobs)
      .set({ status: "running" })
      .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, "pending")));

    const { zipEntries, artifactUrls } = await collectUserData(
      userId,
      orgId,
      bucket,
    );

    const zipBuffer = await assembleZip(zipEntries);

    const s3Key = `exports/${userId}/${jobId}.zip`;
    await uploadS3Buffer(bucket, s3Key, zipBuffer, "application/zip");

    const downloadUrl = await generatePresignedUrl(
      bucket,
      s3Key,
      DOWNLOAD_EXPIRY_SECONDS,
      "data-export.zip",
      true,
    );

    const expiresAtDate = new Date(Date.now() + DOWNLOAD_EXPIRY_MS);
    await db
      .update(exportJobs)
      .set({
        status: "completed",
        s3Key,
        artifactUrls: artifactUrls.length > 0 ? artifactUrls : null,
        completedAt: new Date(),
        expiresAt: expiresAtDate,
      })
      .where(eq(exportJobs.id, jobId));

    // Skip email notification if user has unsubscribed
    if (await isUserUnsubscribed(userId)) {
      log.debug(
        `Export job ${jobId}: user unsubscribed, skipping email notification`,
      );
    } else {
      const user = await getCachedUser(userId);
      const formattedExpiry = expiresAtDate.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const unsubscribeUrl = buildUnsubscribeUrl(userId);

      await enqueueEmail({
        from: buildFromAddress("vm0"),
        to: user.email,
        subject: "Your data export is ready",
        template: {
          template: "data-export-ready",
          props: {
            downloadUrl,
            expiresAt: formattedExpiry,
            artifactCount: artifactUrls.length,
            unsubscribeUrl,
          },
        },
        headers: buildUnsubscribeHeaders(unsubscribeUrl),
      });
    }

    log.debug(`Export job ${jobId} completed successfully`);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error(`Export job ${jobId} failed: ${errorMessage}`);

    await db
      .update(exportJobs)
      .set({
        status: "failed",
        error: errorMessage,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(exportJobs.id, jobId),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      );
  }
}

/**
 * Assemble ZIP from entries using archiver
 */
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
    archive.append(
      typeof entry.content === "string"
        ? Buffer.from(entry.content)
        : entry.content,
      { name: entry.path },
    );
  }

  await archive.finalize();
  return done;
}
