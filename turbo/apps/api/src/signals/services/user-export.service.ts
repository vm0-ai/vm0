import { createHmac } from "node:crypto";
import archiver from "archiver";
import { command, computed, type Computed } from "ccstate";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type {
  UserExportJob,
  UserExportStartResponse,
  UserExportStatusResponse,
} from "@vm0/api-contracts/contracts/user-export";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { conversations } from "@vm0/db/schema/conversation";
import { exportJobs, type ExportArtifactUrl } from "@vm0/db/schema/export-job";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db } from "../external/db";
import { clerk$ } from "../external/clerk";
import {
  downloadS3Buffer,
  generatePresignedGetUrl,
  putS3Object,
} from "../external/s3";
import { nowDate } from "../external/time";
import { safeAsync } from "../utils";

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_URL_EXPIRY_SECONDS = 3600;
const EXPORT_FILENAME = "vm0-data-export.zip";
const EXPORT_DOWNLOAD_EXPIRY_SECONDS = 72 * 60 * 60;
const EXPORT_DOWNLOAD_EXPIRY_MS = EXPORT_DOWNLOAD_EXPIRY_SECONDS * 1000;
const USER_CACHE_TTL_MS = 15 * 60 * 1000;
const DATA_EXPORT_READY_SUBJECT = "Your data export is ready";
const log = logger("service:user-export");

type ExportJobStatus = UserExportJob["status"];
type ActiveExportJobStatus = Extract<ExportJobStatus, "pending" | "running">;

interface StartUserExportArgs {
  readonly userId: string;
  readonly orgId: string;
}

type StartUserExportResult =
  | {
      readonly kind: "accepted";
      readonly jobId: string;
      readonly status: ActiveExportJobStatus;
      readonly shouldExecute: boolean;
    }
  | { readonly kind: "rate_limited" };

interface ExecuteUserExportJobArgs {
  readonly jobId: string;
  readonly userId: string;
  readonly orgId: string;
}

interface ZipEntry {
  readonly path: string;
  readonly content: Buffer | string;
}

interface CollectedData {
  readonly zipEntries: readonly ZipEntry[];
  readonly artifactUrls: readonly ExportArtifactUrl[];
}

interface ExportRuntime {
  readonly db: Db;
  readonly get: <T>(input: Computed<T>) => T;
  readonly signal: AbortSignal;
  readonly bucket: string;
}

interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkEmailProfile {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
}

const EXPORT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const satisfies readonly ExportJobStatus[];

const ACTIVE_EXPORT_JOB_STATUSES = [
  "pending",
  "running",
] as const satisfies readonly ActiveExportJobStatus[];

function isExportJobStatus(status: string): status is ExportJobStatus {
  return EXPORT_JOB_STATUSES.some((candidate) => {
    return candidate === status;
  });
}

function exportJobStatus(status: string): ExportJobStatus {
  if (isExportJobStatus(status)) {
    return status;
  }

  throw new Error(`Unexpected export job status: ${status}`);
}

function isActiveExportJobStatus(
  status: string,
): status is ActiveExportJobStatus {
  return ACTIVE_EXPORT_JOB_STATUSES.some((candidate) => {
    return candidate === status;
  });
}

function activeExportJobStatus(status: string): ActiveExportJobStatus {
  if (isActiveExportJobStatus(status)) {
    return status;
  }

  throw new Error(`Unexpected active export job status: ${status}`);
}

function fromDomain(): string {
  const domain = env("RESEND_FROM_DOMAIN");
  if (!domain) {
    throw new Error("RESEND_FROM_DOMAIN is not configured");
  }
  return domain;
}

function buildFromAddress(localPart: string): string {
  return `Zero <${localPart}@${fromDomain()}>`;
}

function generateUnsubscribeToken(userId: string): string {
  const hmac = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${hmac}`;
}

function buildUnsubscribeUrl(userId: string): string {
  const token = generateUnsubscribeToken(userId);
  return `${env("VM0_API_URL")}/api/email/unsubscribe?token=${token}`;
}

function buildUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function primaryEmail(user: ClerkEmailProfile): string | null {
  const email = user.emailAddresses.find((candidate) => {
    return candidate.id === user.primaryEmailAddressId;
  });
  return email?.emailAddress ?? null;
}

function displayName(user: ClerkEmailProfile): string | null {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
}

export function userExportStatus(userId: string) {
  return computed(async (get): Promise<UserExportStatusResponse> => {
    const db = get(db$);
    const [latestJob] = await db
      .select({
        id: exportJobs.id,
        status: exportJobs.status,
        createdAt: exportJobs.createdAt,
        completedAt: exportJobs.completedAt,
        expiresAt: exportJobs.expiresAt,
        s3Key: exportJobs.s3Key,
        error: exportJobs.error,
      })
      .from(exportJobs)
      .where(eq(exportJobs.userId, userId))
      .orderBy(desc(exportJobs.createdAt))
      .limit(1);

    const now = nowDate();
    const rateLimitCutoff = new Date(now.getTime() - RATE_LIMIT_MS);
    const [recentCompleted] = await db
      .select({ completedAt: exportJobs.completedAt })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, userId),
          eq(exportJobs.status, "completed"),
          gt(exportJobs.completedAt, rateLimitCutoff),
        ),
      )
      .limit(1);

    const [activeJob] = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, userId),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      )
      .limit(1);

    const hasActiveJob = Boolean(activeJob);
    const canExport = !recentCompleted && !hasActiveJob;
    const nextExportAt = recentCompleted?.completedAt
      ? new Date(
          recentCompleted.completedAt.getTime() + RATE_LIMIT_MS,
        ).toISOString()
      : null;

    if (!latestJob) {
      return { job: null, canExport: true, nextExportAt: null };
    }

    let downloadUrl: string | null = null;
    if (
      latestJob.status === "completed" &&
      latestJob.s3Key &&
      latestJob.expiresAt &&
      latestJob.expiresAt > now
    ) {
      downloadUrl = await get(
        generatePresignedGetUrl(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          latestJob.s3Key,
          DOWNLOAD_URL_EXPIRY_SECONDS,
          EXPORT_FILENAME,
          true,
        ),
      );
    }

    return {
      job: {
        id: latestJob.id,
        status: exportJobStatus(latestJob.status),
        createdAt: latestJob.createdAt.toISOString(),
        completedAt: latestJob.completedAt?.toISOString() ?? null,
        expiresAt: latestJob.expiresAt?.toISOString() ?? null,
        downloadUrl,
        error: latestJob.error,
      },
      canExport,
      nextExportAt,
    };
  });
}

export const startUserExport$ = command(
  async (
    { set },
    args: StartUserExportArgs,
    signal: AbortSignal,
  ): Promise<StartUserExportResult> => {
    const db = set(writeDb$);

    const [activeJob] = await db
      .select({ id: exportJobs.id, status: exportJobs.status })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, args.userId),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (activeJob) {
      return {
        kind: "accepted",
        jobId: activeJob.id,
        status: activeExportJobStatus(activeJob.status),
        shouldExecute: false,
      };
    }

    const rateLimitCutoff = new Date(nowDate().getTime() - RATE_LIMIT_MS);
    const [recentCompleted] = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, args.userId),
          eq(exportJobs.status, "completed"),
          gt(exportJobs.completedAt, rateLimitCutoff),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (recentCompleted) {
      return { kind: "rate_limited" };
    }

    const [job] = await db
      .insert(exportJobs)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        status: "pending",
        createdAt: nowDate(),
      })
      .returning({ id: exportJobs.id });
    signal.throwIfAborted();

    if (!job) {
      throw new Error("Failed to create export job");
    }

    return {
      kind: "accepted",
      jobId: job.id,
      status: "pending",
      shouldExecute: true,
    };
  },
);

async function collectInstructions(
  runtime: ExportRuntime,
  userId: string,
  orgId: string,
): Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }> {
  const entries: ZipEntry[] = [];
  let count = 0;

  const composes = await runtime.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(
      and(eq(agentComposes.userId, userId), eq(agentComposes.orgId, orgId)),
    );
  runtime.signal.throwIfAborted();

  for (const compose of composes) {
    if (!compose.headVersionId) {
      continue;
    }

    const [version] = await runtime.db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);
    runtime.signal.throwIfAborted();

    if (version) {
      entries.push({
        path: `instructions/${compose.name}/vm0.yaml`,
        content: JSON.stringify(version.content, null, 2),
      });
      count += 1;
    }

    const instructionsStorageName = `agent-instructions@${compose.name}`;
    const [instructionsStorage] = await runtime.db
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
    runtime.signal.throwIfAborted();

    if (instructionsStorage?.headVersionId) {
      const [storageVersion] = await runtime.db
        .select({ s3Key: storageVersions.s3Key })
        .from(storageVersions)
        .where(eq(storageVersions.id, instructionsStorage.headVersionId))
        .limit(1);
      runtime.signal.throwIfAborted();

      if (storageVersion) {
        const archiveBuffer = await runtime.get(
          downloadS3Buffer(
            runtime.bucket,
            `${storageVersion.s3Key}/archive.tar.gz`,
          ),
        );
        runtime.signal.throwIfAborted();
        entries.push({
          path: `instructions/${compose.name}/instructions.tar.gz`,
          content: archiveBuffer,
        });
      }
    }
  }

  return { entries, count };
}

async function resolveSessionHistory(
  runtime: ExportRuntime,
  hash: string | null,
  legacyText: string | null,
): Promise<string | null> {
  if (hash) {
    const result = await safeAsync(() => {
      return runtime.get(
        downloadS3Buffer(runtime.bucket, `blobs/${hash}.blob`),
      );
    });
    runtime.signal.throwIfAborted();

    if ("ok" in result) {
      return result.ok.toString("utf8");
    }

    if (legacyText) {
      log.warn("session history blob fetch failed, using legacy text", {
        hash,
        error: result.error,
      });
      return legacyText;
    }

    throw result.error;
  }

  return legacyText;
}

async function collectConversations(
  runtime: ExportRuntime,
  userId: string,
): Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }> {
  const entries: ZipEntry[] = [];
  let count = 0;

  const threads = await runtime.db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId));
  runtime.signal.throwIfAborted();

  for (const thread of threads) {
    const messages = await runtime.db
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
    runtime.signal.throwIfAborted();

    if (messages.length > 0) {
      entries.push({
        path: `conversations/chat-thread-${thread.id}.json`,
        content: JSON.stringify(messages, null, 2),
      });
      count += 1;
    }
  }

  const sessionsWithConversations = await runtime.db
    .select({
      id: agentSessions.id,
      conversationId: agentSessions.conversationId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.userId, userId));
  runtime.signal.throwIfAborted();

  for (const session of sessionsWithConversations) {
    if (!session.conversationId) {
      continue;
    }

    const [conversation] = await runtime.db
      .select({
        cliAgentSessionHistoryHash: conversations.cliAgentSessionHistoryHash,
        cliAgentSessionHistory: conversations.cliAgentSessionHistory,
      })
      .from(conversations)
      .where(eq(conversations.id, session.conversationId))
      .limit(1);
    runtime.signal.throwIfAborted();

    if (conversation) {
      const history = await resolveSessionHistory(
        runtime,
        conversation.cliAgentSessionHistoryHash,
        conversation.cliAgentSessionHistory,
      );

      if (history) {
        entries.push({
          path: `conversations/${session.id}-history.jsonl`,
          content: history,
        });
      }
    }
  }

  return { entries, count };
}

async function collectArtifacts(
  runtime: ExportRuntime,
  userId: string,
  orgId: string,
  expiresAt: Date,
): Promise<readonly ExportArtifactUrl[]> {
  const artifactStorages = await runtime.db
    .select({
      name: storages.name,
      headVersionId: storages.headVersionId,
      fileCount: storages.fileCount,
    })
    .from(storages)
    .where(
      and(
        eq(storages.userId, userId),
        eq(storages.orgId, orgId),
        eq(storages.type, "artifact"),
      ),
    );
  runtime.signal.throwIfAborted();

  const artifactUrls: ExportArtifactUrl[] = [];

  for (const artifact of artifactStorages) {
    if (!artifact.headVersionId || artifact.fileCount === 0) {
      continue;
    }

    const [storageVersion] = await runtime.db
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(eq(storageVersions.id, artifact.headVersionId))
      .limit(1);
    runtime.signal.throwIfAborted();

    if (storageVersion) {
      const archiveKey = `${storageVersion.s3Key}/archive.tar.gz`;
      const presignedUrl = await runtime.get(
        generatePresignedGetUrl(
          runtime.bucket,
          archiveKey,
          EXPORT_DOWNLOAD_EXPIRY_SECONDS,
          `${artifact.name}.tar.gz`,
          true,
        ),
      );
      runtime.signal.throwIfAborted();

      artifactUrls.push({
        name: artifact.name,
        downloadUrl: presignedUrl,
        expiresAt: expiresAt.toISOString(),
      });
    }
  }

  return artifactUrls;
}

async function collectUserData(
  runtime: ExportRuntime,
  userId: string,
  orgId: string,
  expiresAt: Date,
): Promise<CollectedData> {
  const instructions = await collectInstructions(runtime, userId, orgId);
  const conversationsResult = await collectConversations(runtime, userId);
  const artifactUrls = await collectArtifacts(
    runtime,
    userId,
    orgId,
    expiresAt,
  );
  const zipEntries: ZipEntry[] = [
    ...instructions.entries,
    ...conversationsResult.entries,
  ];

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
        exportedAt: nowDate().toISOString(),
        userId,
        orgId,
        counts: {
          instructions: instructions.count,
          conversations: conversationsResult.count,
          artifacts: artifactUrls.length,
        },
      },
      null,
      2,
    ),
  });

  return { zipEntries, artifactUrls };
}

async function assembleZip(entries: readonly ZipEntry[]): Promise<Buffer> {
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

async function isUserUnsubscribed(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.emailUnsubscribed ?? false;
}

async function getCachedUserEmail(
  runtime: ExportRuntime,
  userId: string,
): Promise<string> {
  const [cached] = await runtime.db
    .select({ email: userCache.email, cachedAt: userCache.cachedAt })
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);
  runtime.signal.throwIfAborted();

  if (
    cached &&
    nowDate().getTime() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS
  ) {
    return cached.email;
  }

  const client = runtime.get(clerk$);
  const clerkUsers = await client.users.getUserList({ userId: [userId] });
  runtime.signal.throwIfAborted();

  const user = clerkUsers.data.find((candidate: ClerkEmailProfile) => {
    return candidate.id === userId;
  });
  if (!user) {
    throw new Error(`No Clerk user found for user ${userId}`);
  }

  const email = primaryEmail(user);
  if (!email) {
    throw new Error(`No primary email found for user ${userId}`);
  }

  await runtime.db
    .insert(userCache)
    .values({
      userId,
      email,
      name: displayName(user),
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: { email, name: displayName(user), cachedAt: nowDate() },
    });
  runtime.signal.throwIfAborted();

  return email;
}

async function enqueueExportReadyEmail(
  runtime: ExportRuntime,
  args: {
    readonly userId: string;
    readonly downloadUrl: string;
    readonly expiresAt: Date;
    readonly artifactCount: number;
  },
): Promise<void> {
  if (await isUserUnsubscribed(runtime.db, args.userId)) {
    log.debug("export email skipped because user is unsubscribed", {
      userId: args.userId,
    });
    return;
  }
  runtime.signal.throwIfAborted();

  const email = await getCachedUserEmail(runtime, args.userId);
  const unsubscribeUrl = buildUnsubscribeUrl(args.userId);
  const formattedExpiry = args.expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  await runtime.db.insert(emailOutbox).values({
    fromAddress: buildFromAddress("vm0"),
    toAddresses: email,
    subject: DATA_EXPORT_READY_SUBJECT,
    headers: buildUnsubscribeHeaders(unsubscribeUrl),
    template: {
      template: "data-export-ready",
      props: {
        downloadUrl: args.downloadUrl,
        expiresAt: formattedExpiry,
        artifactCount: args.artifactCount,
        unsubscribeUrl,
      },
    },
    status: "pending",
    attempts: 0,
  });
  runtime.signal.throwIfAborted();
}

function exportStartResponse(
  result: Extract<StartUserExportResult, { readonly kind: "accepted" }>,
): UserExportStartResponse {
  return { jobId: result.jobId, status: result.status };
}

export function toUserExportStartResponse(
  result: Extract<StartUserExportResult, { readonly kind: "accepted" }>,
): UserExportStartResponse {
  return exportStartResponse(result);
}

async function runExportJob(
  runtime: ExportRuntime,
  args: ExecuteUserExportJobArgs,
): Promise<void> {
  await runtime.db
    .update(exportJobs)
    .set({ status: "running" })
    .where(
      and(eq(exportJobs.id, args.jobId), eq(exportJobs.status, "pending")),
    );
  runtime.signal.throwIfAborted();

  const expiresAt = new Date(nowDate().getTime() + EXPORT_DOWNLOAD_EXPIRY_MS);
  const { zipEntries, artifactUrls } = await collectUserData(
    runtime,
    args.userId,
    args.orgId,
    expiresAt,
  );
  runtime.signal.throwIfAborted();

  const zipBuffer = await assembleZip(zipEntries);
  runtime.signal.throwIfAborted();

  const s3Key = `exports/${args.userId}/${args.jobId}.zip`;
  await runtime.get(
    putS3Object(runtime.bucket, s3Key, zipBuffer, "application/zip"),
  );
  runtime.signal.throwIfAborted();

  const downloadUrl = await runtime.get(
    generatePresignedGetUrl(
      runtime.bucket,
      s3Key,
      EXPORT_DOWNLOAD_EXPIRY_SECONDS,
      "data-export.zip",
      true,
    ),
  );
  runtime.signal.throwIfAborted();

  await runtime.db
    .update(exportJobs)
    .set({
      status: "completed",
      s3Key,
      artifactUrls: artifactUrls.length > 0 ? [...artifactUrls] : null,
      completedAt: nowDate(),
      expiresAt,
    })
    .where(eq(exportJobs.id, args.jobId));
  runtime.signal.throwIfAborted();

  await enqueueExportReadyEmail(runtime, {
    userId: args.userId,
    downloadUrl,
    expiresAt,
    artifactCount: artifactUrls.length,
  });
  runtime.signal.throwIfAborted();

  log.debug("export job completed", { jobId: args.jobId });
}

export const executeUserExportJob$ = command(
  async (
    { get, set },
    args: ExecuteUserExportJobArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const runtime: ExportRuntime = {
      db,
      get,
      signal,
      bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    };

    const result = await safeAsync(() => {
      return runExportJob(runtime, args);
    });
    signal.throwIfAborted();

    if ("ok" in result) {
      return;
    }

    const errorMessage =
      result.error instanceof Error ? result.error.message : "Unknown error";
    log.error("export job failed", { jobId: args.jobId, error: result.error });

    await db
      .update(exportJobs)
      .set({
        status: "failed",
        error: errorMessage,
        completedAt: nowDate(),
      })
      .where(
        and(
          eq(exportJobs.id, args.jobId),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      );
    signal.throwIfAborted();
  },
);
