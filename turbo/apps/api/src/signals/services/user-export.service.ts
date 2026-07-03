import { createHash, createHmac } from "node:crypto";
import archiver from "archiver";
import { command, computed, type Computed } from "ccstate";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@vm0/api-contracts/contracts/runners";
import type {
  UserExportJob,
  UserExportStartResponse,
  UserExportStatusResponse,
} from "@vm0/api-contracts/contracts/user-export";
import {
  getInstructionsStorageName,
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { blobs } from "@vm0/db/schema/blob";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { conversations } from "@vm0/db/schema/conversation";
import { exportJobs } from "@vm0/db/schema/export-job";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { extractFilesFromTarGz } from "../../lib/tar";
import { db$, writeDb$, type Db } from "../external/db";
import { clerk$ } from "../external/clerk";
import {
  downloadManifest,
  downloadS3Buffer,
  downloadS3BufferWithMaxBytes,
  generatePresignedGetUrl,
  putS3Object,
} from "../external/s3";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  normalizeSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  type SessionHistoryBlobEncoding,
  SESSION_HISTORY_ENCODING_GZIP,
} from "./session-history-blobs";
import { gunzipSessionHistoryBufferWithMaxBytes } from "./session-history-decompression";
import { loadWorkflowVolumeFiles } from "./zero-workflow-volume.service";

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

interface VolumeFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

interface ExportTextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[\\/]+/g, "-").trim() || "unnamed";
}

function normalizeExportFilePath(path: string): string {
  const parts = path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => {
      return part.length > 0 && part !== ".";
    });

  if (
    parts.some((part) => {
      return part === "..";
    })
  ) {
    throw new Error(`Invalid export file path: ${path}`);
  }

  return parts.join("/") || "file";
}

function scopedExportPath(args: {
  readonly scope: string;
  readonly name: string;
  readonly id: string;
  readonly filePath: string;
}): string {
  const folder = `${sanitizePathSegment(args.name)}-${args.id}`;
  return `${args.scope}/${folder}/${normalizeExportFilePath(args.filePath)}`;
}

async function loadStorageVolumeFiles(
  runtime: ExportRuntime,
  args: {
    readonly orgId: string;
    readonly storageName: string;
  },
): Promise<readonly VolumeFile[]> {
  const [storage] = await runtime.db
    .select({ id: storages.id, headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, args.storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);
  runtime.signal.throwIfAborted();

  if (!storage?.headVersionId) {
    return [];
  }

  return await loadStorageVersionFiles(runtime, {
    storageId: storage.id,
    headVersionId: storage.headVersionId,
  });
}

async function loadStorageVersionFiles(
  runtime: ExportRuntime,
  args: {
    readonly storageId: string;
    readonly headVersionId: string | null;
  },
): Promise<readonly VolumeFile[]> {
  if (!args.headVersionId) {
    return [];
  }

  const [version] = await runtime.db
    .select({ s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, args.storageId),
        eq(storageVersions.id, args.headVersionId),
      ),
    )
    .limit(1);
  runtime.signal.throwIfAborted();

  if (!version) {
    return [];
  }

  const manifest = await runtime.get(
    downloadManifest(runtime.bucket, version.s3Key),
  );
  runtime.signal.throwIfAborted();

  const filesList = manifest.files.map((file) => {
    return {
      path: normalizeExportFilePath(file.path),
      size: file.size,
    };
  });
  const archiveBuffer = await runtime.get(
    downloadS3Buffer(runtime.bucket, `${version.s3Key}/archive.tar.gz`),
  );
  runtime.signal.throwIfAborted();

  const contents = extractFilesFromTarGz(
    archiveBuffer,
    filesList.map((file) => {
      return file.path;
    }),
  );
  const sizeByPath = new Map(
    filesList.map((file) => {
      return [file.path, file.size];
    }),
  );

  return contents.map((file) => {
    const path = normalizeExportFilePath(file.path);
    return {
      path,
      content: file.content,
      size: sizeByPath.get(path) ?? Buffer.byteLength(file.content, "utf8"),
    };
  });
}

async function collectAgentInstructionFiles(
  runtime: ExportRuntime,
  userId: string,
): Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }> {
  const entries: ZipEntry[] = [];

  const composes = await runtime.db
    .select({
      id: agentComposes.id,
      orgId: agentComposes.orgId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.userId, userId))
    .orderBy(asc(agentComposes.orgId), asc(agentComposes.name));
  runtime.signal.throwIfAborted();

  for (const compose of composes) {
    const files = await loadStorageVolumeFiles(runtime, {
      orgId: compose.orgId,
      storageName: getInstructionsStorageName(compose.name),
    });
    runtime.signal.throwIfAborted();

    for (const file of files) {
      entries.push({
        path: scopedExportPath({
          scope: "agents",
          name: compose.name,
          id: compose.id,
          filePath: file.path,
        }),
        content: file.content,
      });
    }
  }

  return { entries, count: entries.length };
}

async function collectWorkflowFiles(
  runtime: ExportRuntime,
  userId: string,
): Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }> {
  const entries: ZipEntry[] = [];

  const workflows = await runtime.db
    .select({
      id: zeroWorkflows.id,
      orgId: zeroWorkflows.orgId,
      name: zeroWorkflows.name,
      createdAt: zeroWorkflows.createdAt,
    })
    .from(zeroWorkflows)
    .where(eq(zeroWorkflows.ownerUserId, userId))
    .orderBy(
      asc(zeroWorkflows.orgId),
      asc(zeroWorkflows.name),
      asc(zeroWorkflows.createdAt),
    );
  runtime.signal.throwIfAborted();

  for (const workflow of workflows) {
    const files =
      (await loadWorkflowVolumeFiles(runtime.get, {
        orgId: workflow.orgId,
        workflowId: workflow.id,
      })) ?? [];
    runtime.signal.throwIfAborted();

    for (const file of files) {
      entries.push({
        path: scopedExportPath({
          scope: "workflows",
          name: workflow.name,
          id: workflow.id,
          filePath: file.path,
        }),
        content: file.content,
      });
    }
  }

  return { entries, count: entries.length };
}

async function collectMemoryFiles(
  runtime: ExportRuntime,
  userId: string,
): Promise<{ readonly entries: readonly ZipEntry[]; readonly count: number }> {
  const entries: ZipEntry[] = [];

  const memoryStorages = await runtime.db
    .select({
      id: storages.id,
      orgId: storages.orgId,
      headVersionId: storages.headVersionId,
      fileCount: storages.fileCount,
    })
    .from(storages)
    .where(
      and(
        eq(storages.userId, userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        eq(storages.type, "artifact"),
      ),
    )
    .orderBy(asc(storages.orgId));
  runtime.signal.throwIfAborted();

  for (const memoryStorage of memoryStorages) {
    if (memoryStorage.fileCount === 0) {
      continue;
    }

    const files = await loadStorageVersionFiles(runtime, {
      storageId: memoryStorage.id,
      headVersionId: memoryStorage.headVersionId,
    });
    runtime.signal.throwIfAborted();

    for (const file of files) {
      entries.push({
        path: `memory/${sanitizePathSegment(
          memoryStorage.orgId,
        )}/${normalizeExportFilePath(file.path)}`,
        content: file.content,
      });
    }
  }

  return { entries, count: entries.length };
}

function exportMessageRole(role: string): "user" | "assistant" | null {
  if (role === "user" || role === "assistant") {
    return role;
  }
  return null;
}

interface ResolveSessionHistoryArgs {
  readonly hash: string | null;
  readonly encoding: string | null;
  readonly rawSize: number | null;
  readonly encodedSize: number | null;
  readonly legacyText: string | null;
}

async function resolveSessionHistory(
  runtime: ExportRuntime,
  args: ResolveSessionHistoryArgs,
): Promise<Buffer | string | null> {
  if (args.hash) {
    const normalizedEncoding = normalizeSessionHistoryBlobEncoding(
      args.encoding,
    );
    const rawSize = args.rawSize && args.rawSize > 0 ? args.rawSize : undefined;
    const encodedSize =
      args.encodedSize && args.encodedSize > 0 ? args.encodedSize : undefined;
    const key = resumeSessionHistoryBlobKey(args.hash, normalizedEncoding);
    const result = await settle(
      loadSessionHistoryBlob(runtime, {
        encoding: normalizedEncoding,
        encodedSize,
        hash: args.hash,
        key,
        rawSize,
      }),
    );
    runtime.signal.throwIfAborted();

    if (result.ok) {
      return result.value;
    }

    throw result.error;
  }

  return args.legacyText;
}

async function loadSessionHistoryBlob(
  runtime: ExportRuntime,
  args: {
    readonly encodedSize: number | undefined;
    readonly encoding: SessionHistoryBlobEncoding;
    readonly hash: string;
    readonly key: string;
    readonly rawSize: number | undefined;
  },
): Promise<Buffer> {
  const encodedBuffer = await runtime.get(
    downloadS3BufferWithMaxBytes(
      runtime.bucket,
      args.key,
      args.encodedSize ?? RESUME_SESSION_HISTORY_MAX_BYTES,
    ),
  );
  const rawBuffer =
    args.encoding === SESSION_HISTORY_ENCODING_GZIP
      ? await gunzipSessionHistoryBufferWithMaxBytes(
          args.key,
          encodedBuffer,
          args.rawSize ?? RESUME_SESSION_HISTORY_MAX_BYTES,
        )
      : encodedBuffer;
  return verifySessionHistoryBuffer(args.hash, rawBuffer, args.rawSize);
}

function verifySessionHistoryBuffer(
  hash: string,
  buffer: Buffer,
  expectedSize: number | undefined,
): Buffer {
  if (expectedSize !== undefined && buffer.length !== expectedSize) {
    throw new Error(
      `session history size mismatch: expected ${expectedSize} bytes, got ${buffer.length} bytes`,
    );
  }
  const actualHash = createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== hash) {
    throw new Error(`session history hash mismatch: expected ${hash}`);
  }
  return buffer;
}

async function collectConversationMessages(
  runtime: ExportRuntime,
  userId: string,
): Promise<{
  readonly entries: readonly ZipEntry[];
  readonly threadCount: number;
  readonly sessionHistoryCount: number;
}> {
  const entries: ZipEntry[] = [];
  let threadCount = 0;
  let sessionHistoryCount = 0;

  const threads = await runtime.db
    .select({ id: chatThreads.id, createdAt: chatThreads.createdAt })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(asc(chatThreads.createdAt));
  runtime.signal.throwIfAborted();

  for (const thread of threads) {
    const rows = await runtime.db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, thread.id),
          inArray(chatMessages.role, ["user", "assistant"]),
        ),
      )
      .orderBy(asc(chatMessages.createdAt));
    runtime.signal.throwIfAborted();

    const messages: ExportTextMessage[] = rows.flatMap((message) => {
      const role = exportMessageRole(message.role);
      if (!role || !message.content) {
        return [];
      }
      return [
        {
          role,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
        },
      ];
    });

    if (messages.length > 0) {
      entries.push({
        path: `conversations/chat-thread-${thread.id}.json`,
        content: JSON.stringify(messages, null, 2),
      });
      threadCount += 1;
    }
  }

  const sessionsWithHistory = await runtime.db
    .select({
      id: agentSessions.id,
      cliAgentSessionHistoryHash: conversations.cliAgentSessionHistoryHash,
      cliAgentSessionHistory: conversations.cliAgentSessionHistory,
      sessionHistoryBlobEncoding: blobs.encoding,
      sessionHistoryBlobEncodedSize: blobs.encodedSize,
      sessionHistoryBlobRawSize: blobs.rawSize,
    })
    .from(agentSessions)
    .innerJoin(
      conversations,
      eq(conversations.id, agentSessions.conversationId),
    )
    .leftJoin(blobs, eq(conversations.cliAgentSessionHistoryHash, blobs.hash))
    .where(eq(agentSessions.userId, userId))
    .orderBy(asc(agentSessions.createdAt), asc(agentSessions.id));
  runtime.signal.throwIfAborted();

  for (const session of sessionsWithHistory) {
    const history = await resolveSessionHistory(runtime, {
      hash: session.cliAgentSessionHistoryHash,
      encoding: session.sessionHistoryBlobEncoding,
      rawSize: session.sessionHistoryBlobRawSize,
      encodedSize: session.sessionHistoryBlobEncodedSize,
      legacyText: session.cliAgentSessionHistory,
    });

    if (history) {
      entries.push({
        path: `conversations/${session.id}-history.jsonl`,
        content: history,
      });
      sessionHistoryCount += 1;
    }
  }

  return { entries, threadCount, sessionHistoryCount };
}

async function collectUserData(
  runtime: ExportRuntime,
  userId: string,
  orgId: string,
): Promise<CollectedData> {
  const agentInstructions = await collectAgentInstructionFiles(runtime, userId);
  const workflows = await collectWorkflowFiles(runtime, userId);
  const memory = await collectMemoryFiles(runtime, userId);
  const conversationsResult = await collectConversationMessages(
    runtime,
    userId,
  );
  const zipEntries: ZipEntry[] = [
    ...agentInstructions.entries,
    ...workflows.entries,
    ...memory.entries,
    ...conversationsResult.entries,
  ];

  zipEntries.push({
    path: "export-manifest.json",
    content: JSON.stringify(
      {
        exportedAt: nowDate().toISOString(),
        userId,
        requestOrgId: orgId,
        counts: {
          agentInstructionFiles: agentInstructions.count,
          workflowFiles: workflows.count,
          memoryFiles: memory.count,
          conversationThreads: conversationsResult.threadCount,
          sessionHistories: conversationsResult.sessionHistoryCount,
        },
      },
      null,
      2,
    ),
  });

  return { zipEntries };
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
  const { zipEntries } = await collectUserData(
    runtime,
    args.userId,
    args.orgId,
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
      artifactUrls: null,
      completedAt: nowDate(),
      expiresAt,
    })
    .where(eq(exportJobs.id, args.jobId));
  runtime.signal.throwIfAborted();

  await enqueueExportReadyEmail(runtime, {
    userId: args.userId,
    downloadUrl,
    expiresAt,
    artifactCount: 0,
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

    const result = await settle(runExportJob(runtime, args));
    signal.throwIfAborted();

    if (result.ok) {
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
