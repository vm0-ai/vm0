import { v5 as uuidv5 } from "uuid";

import {
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  socialKitDownloadFormatSchema,
  socialKitDownloadPlatformSchema,
  socialKitDownloadQualitySchema,
  socialKitDownloadResponseSchema,
  type SocialKitDownloadRequest,
  type SocialKitDownloadResponse,
} from "@okouai/api-contracts/contracts/social";
import { socialKitDownloadJobs } from "@okouai/db/schema/socialkit-download-job";
import { command } from "ccstate";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import {
  abortMultipartS3Upload,
  completeMultipartS3Upload,
  createMultipartS3Upload,
  uploadMultipartS3Part,
  type MultipartS3Part,
} from "../external/s3";
import { type Db, writeDb$ } from "../external/db";
import {
  awaitWithSignal,
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  settle,
  settleIncludingAbort,
  startUntrackedBestEffortCleanup,
} from "../utils";
import {
  allocateArtifactObject$,
  resolveArtifactObject$,
} from "./artifact-storage.service";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { validateScrapeTargetUrl } from "./scrape-target-policy";

const SOCIALKIT_API_BASE = "https://api.socialkit.dev";
const SOCIALKIT_PROVIDER_TIMEOUT_MS = 240_000;
const SOCIALKIT_DOWNLOAD_TIMEOUT_MS = 270_000;
export const SOCIALKIT_RECONCILIATION_TIMEOUT_MS = 280_000;
const MULTIPART_CLEANUP_TIMEOUT_MS = 10_000;
const CLAIM_CLEANUP_TIMEOUT_MS = 10_000;
// SocialKit charges when ready is observed, so durable settlement gets an independent budget.
const READY_SETTLEMENT_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const RECONCILE_BATCH_SIZE = 2;
const USAGE_NAMESPACE = "42a65d9f-67d6-4bed-ae87-9f80ce1feb79";
const ACTIVE_STATUSES = [
  "processing",
  "materializing",
  "artifact_failed",
] as const;

type DownloadJob = typeof socialKitDownloadJobs.$inferSelect;

interface SocialKitDownloadErrorResponse {
  readonly status: 502 | 503;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

type CreateSocialKitDownloadResponse =
  | { readonly status: 202; readonly body: SocialKitDownloadResponse }
  | ManagedUsageErrorResponse
  | SocialKitDownloadErrorResponse;

interface CreateSocialKitDownloadArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: SocialKitDownloadRequest;
  readonly publicBrand: "vm0" | "okou";
}

const providerStartSchema = z.object({
  jobId: z.string().min(1).max(512),
  status: z.enum(["queued", "processing"]),
});

const providerFileSizeMbSchema = z.union([
  z.number().nonnegative(),
  z
    .string()
    .max(32)
    .regex(/^\d+(?:\.\d+)? MB$/u)
    .transform((value) => {
      return Number.parseFloat(value);
    })
    .pipe(z.number().finite().nonnegative()),
]);

const providerReadySchema = z.object({
  jobId: z.string().min(1).max(512),
  status: z.literal("ready"),
  platform: socialKitDownloadPlatformSchema,
  downloadUrl: z.url().max(8192),
  durationSeconds: z.number().int().positive(),
  fileSizeMB: providerFileSizeMbSchema,
  creditsCost: z.number().int().positive(),
  quality: socialKitDownloadQualitySchema,
  format: socialKitDownloadFormatSchema,
  title: z.unknown().optional(),
  thumbnail: z.unknown().optional(),
});

const providerThumbnailSchema = z
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  });

function errorResponse(
  status: 502 | 503,
  message: string,
  code: string,
): SocialKitDownloadErrorResponse {
  return { status, body: { error: { message, code } } };
}

function runId(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function externalStatus(job: DownloadJob): SocialKitDownloadResponse["status"] {
  switch (job.status) {
    case "submitting": {
      return "queued";
    }
    case "processing": {
      return "processing";
    }
    case "materializing": {
      return "materializing";
    }
    case "artifact_failed": {
      return "artifact_failed";
    }
    case "provider_failed": {
      return "provider_failed";
    }
    case "completed": {
      return "completed";
    }
  }
}

function responseForJob(job: DownloadJob): SocialKitDownloadResponse {
  const billed = job.creditsCharged !== null;
  return socialKitDownloadResponseSchema.parse({
    downloadId: job.id,
    status: externalStatus(job),
    platform: job.request.platform,
    quality: job.request.quality,
    format: job.request.format,
    maxDuration: job.request.maxDuration,
    billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
    provider: job.providerResult,
    billing:
      job.providerResult && billed
        ? {
            quantity: job.providerResult.creditsCost,
            creditsCharged: job.creditsCharged,
          }
        : null,
    artifact: job.artifact,
    error: job.error
      ? {
          ...job.error,
          retryable:
            job.status === "processing" || job.status === "artifact_failed",
          billed,
        }
      : null,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
}

function providerBody(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    value.success === true &&
    "data" in value
  ) {
    return value.data;
  }
  return value;
}

async function providerJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(SOCIALKIT_PROVIDER_TIMEOUT_MS),
    ]),
  });
  const text = await readBoundedResponseText(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (text.kind === "too_large") {
    throw new Error("SocialKit returned an oversized job response");
  }
  return {
    response,
    body: providerBody(text.text ? safeJsonParse(text.text) : undefined),
  };
}

async function startProviderJob(
  accessKey: string,
  request: SocialKitDownloadRequest,
  signal: AbortSignal,
): Promise<string> {
  const result = await providerJson(
    `${SOCIALKIT_API_BASE}/v2/${request.platform}/download`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-key": accessKey,
      },
      body: JSON.stringify({
        url: request.url,
        max_duration: request.maxDuration,
        quality: request.quality,
        format: request.format,
      }),
    },
    signal,
  );
  if (!result.response.ok) {
    throw new Error(
      `SocialKit download start failed (${result.response.status})`,
    );
  }
  return providerStartSchema.parse(result.body).jobId;
}

type ProviderPollResult =
  | { readonly status: "processing" }
  | { readonly status: "failed" }
  | { readonly status: "invalid" }
  | {
      readonly status: "ready";
      readonly ready: z.infer<typeof providerReadySchema>;
    };

async function pollProviderJob(
  accessKey: string,
  providerJobId: string,
  signal: AbortSignal,
): Promise<ProviderPollResult> {
  const result = await providerJson(
    `${SOCIALKIT_API_BASE}/v2/downloads/${encodeURIComponent(providerJobId)}`,
    { method: "GET", headers: { "x-access-key": accessKey } },
    signal,
  );
  if (!result.response.ok) {
    if (result.response.status === 404) {
      return { status: "failed" };
    }
    throw new Error(
      `SocialKit download status failed (${result.response.status})`,
    );
  }
  if (
    typeof result.body !== "object" ||
    result.body === null ||
    !("status" in result.body) ||
    typeof result.body.status !== "string"
  ) {
    return { status: "invalid" };
  }
  if (result.body.status === "failed") {
    return { status: "failed" };
  }
  if (result.body.status === "queued" || result.body.status === "processing") {
    return { status: "processing" };
  }
  if (result.body.status !== "ready") {
    return { status: "invalid" };
  }
  const ready = providerReadySchema.safeParse(result.body);
  return ready.success
    ? { status: "ready", ready: ready.data }
    : { status: "invalid" };
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchSafeSocialKitArtifact(
  initialUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const target = await awaitWithSignal(
      validateScrapeTargetUrl(currentUrl),
      signal,
    );
    signal.throwIfAborted();
    if (typeof target === "string" || target.url.protocol !== "https:") {
      throw new Error("SocialKit returned an unsafe artifact URL");
    }
    const response = await fetch(target.url, {
      redirect: "manual",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(SOCIALKIT_DOWNLOAD_TIMEOUT_MS),
      ]),
    });
    signal.throwIfAborted();
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("SocialKit artifact redirect is invalid");
    }
    currentUrl = new URL(location, target.url).toString();
  }
  throw new Error("SocialKit artifact redirected too many times");
}

const streamDownloadToArtifact$ = command(
  async (
    { get },
    args: {
      readonly downloadUrl: string;
      readonly bucket: string;
      readonly key: string;
      readonly contentType: string;
      readonly metadata: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const response = await fetchSafeSocialKitArtifact(args.downloadUrl, signal);
    signal.throwIfAborted();
    if (!response.ok || !response.body) {
      if (response.body) {
        startUntrackedBestEffortCleanup(response.body.cancel());
      }
      throw new Error("SocialKit artifact download failed");
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
      startUntrackedBestEffortCleanup(response.body.cancel());
      throw new Error("SocialKit artifact exceeds the 2 GiB limit");
    }

    const parts: MultipartS3Part[] = [];
    const reader = response.body.getReader();
    let uploadId: string | undefined;
    let chunks: Uint8Array[] = [];
    let bufferedBytes = 0;
    let totalBytes = 0;

    const uploadBuffered = async (): Promise<void> => {
      if (bufferedBytes === 0) {
        return;
      }
      if (!uploadId) {
        throw new Error("SocialKit multipart upload was not initialized");
      }
      const part = await get(
        uploadMultipartS3Part(
          {
            bucket: args.bucket,
            key: args.key,
            uploadId,
            partNumber: parts.length + 1,
            body: concatChunks(chunks, bufferedBytes),
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      parts.push(part);
      chunks = [];
      bufferedBytes = 0;
    };

    return await onRejection(
      (async (): Promise<number> => {
        uploadId = await get(
          createMultipartS3Upload(
            args.bucket,
            args.key,
            args.contentType,
            args.metadata,
            signal,
          ),
        );
        signal.throwIfAborted();
        while (true) {
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) {
            break;
          }
          let offset = 0;
          while (offset < next.value.byteLength) {
            const remaining = MULTIPART_PART_BYTES - bufferedBytes;
            const length = Math.min(remaining, next.value.byteLength - offset);
            const piece = next.value.subarray(offset, offset + length);
            chunks.push(piece);
            bufferedBytes += piece.byteLength;
            totalBytes += piece.byteLength;
            if (totalBytes > MAX_DOWNLOAD_BYTES) {
              throw new Error("SocialKit artifact exceeds the 2 GiB limit");
            }
            offset += length;
            if (bufferedBytes === MULTIPART_PART_BYTES) {
              await uploadBuffered();
              signal.throwIfAborted();
            }
          }
        }
        if (totalBytes === 0) {
          throw new Error("SocialKit returned an empty artifact");
        }
        await uploadBuffered();
        signal.throwIfAborted();
        await get(
          completeMultipartS3Upload(
            args.bucket,
            args.key,
            uploadId,
            parts,
            signal,
          ),
        );
        signal.throwIfAborted();
        reader.releaseLock();
        return totalBytes;
      })(),
      async () => {
        startUntrackedBestEffortCleanup(reader.cancel());
        if (uploadId) {
          await settleIncludingAbort(
            get(
              abortMultipartS3Upload(
                args.bucket,
                args.key,
                uploadId,
                AbortSignal.timeout(MULTIPART_CLEANUP_TIMEOUT_MS),
              ),
            ),
          );
        }
      },
    );
  },
);

function usageIdempotencyKey(downloadId: string): string {
  return uuidv5(
    `${downloadId}:${MANAGED_SOCIALKIT_BILLING_CATEGORY}`,
    USAGE_NAMESPACE,
  );
}

function readyMetadataIsValid(
  job: DownloadJob,
  ready: z.infer<typeof providerReadySchema>,
): boolean {
  const expectedCredits = Math.max(1, Math.ceil(ready.durationSeconds / 60));
  const maximumCredits = Math.max(1, Math.ceil(job.request.maxDuration / 60));
  return !(
    ready.jobId !== job.providerJobId ||
    ready.platform !== job.request.platform ||
    ready.format !== job.request.format ||
    ready.durationSeconds > job.request.maxDuration ||
    ready.creditsCost !== expectedCredits ||
    ready.creditsCost > maximumCredits
  );
}

async function deferClaimedJob(
  writeDb: Db,
  job: DownloadJob,
  signal: AbortSignal,
): Promise<void> {
  const [current] = await writeDb
    .select({ creditsCharged: socialKitDownloadJobs.creditsCharged })
    .from(socialKitDownloadJobs)
    .where(
      and(
        eq(socialKitDownloadJobs.id, job.id),
        inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
      ),
    );
  signal.throwIfAborted();
  const billed = current !== undefined && current.creditsCharged !== null;
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: billed ? "artifact_failed" : "processing",
      error: {
        code: billed
          ? "ARTIFACT_MATERIALIZATION_FAILED"
          : "SOCIALKIT_RECONCILIATION_FAILED",
        message: billed
          ? "The artifact could not be materialized"
          : "The SocialKit download could not be reconciled yet",
      },
      retryCount: sql`${socialKitDownloadJobs.retryCount} + 1`,
      claimExpiresAt: sql`now() + LEAST(30, ${socialKitDownloadJobs.retryCount} + 1) * interval '1 minute'`,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(socialKitDownloadJobs.id, job.id),
        inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
      ),
    );
  signal.throwIfAborted();
}

async function startAndPersistProviderJob(
  writeDb: Db,
  created: DownloadJob,
  accessKey: string,
  request: SocialKitDownloadRequest,
): Promise<DownloadJob | null> {
  const started = await settleIncludingAbort(
    startProviderJob(
      accessKey,
      request,
      AbortSignal.timeout(SOCIALKIT_PROVIDER_TIMEOUT_MS),
    ),
  );
  if (!started.ok) {
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "provider_failed",
        error: {
          code: "SOCIALKIT_DOWNLOAD_START_FAILED",
          message: "SocialKit could not start the download",
        },
        updatedAt: nowDate(),
        completedAt: nowDate(),
      })
      .where(eq(socialKitDownloadJobs.id, created.id));
    return null;
  }

  const [processing] = await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "processing",
      providerJobId: started.value,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(socialKitDownloadJobs.id, created.id),
        eq(socialKitDownloadJobs.status, "submitting"),
      ),
    )
    .returning();
  if (!processing) {
    throw new Error("Failed to persist SocialKit provider job");
  }
  return processing;
}

export const createSocialKitDownload$ = command(
  async (
    { set },
    args: CreateSocialKitDownloadArgs,
    signal: AbortSignal,
  ): Promise<CreateSocialKitDownloadResponse> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return errorResponse(
        503,
        "Okou SocialKit provider is not configured",
        "NOT_CONFIGURED",
      );
    }
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: {
          kind: "social",
          provider: "socialkit",
          category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
          quantity: Math.max(1, Math.ceil(args.body.maxDuration / 60)),
        },
        label: "Okou SocialKit download",
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const writeDb = set(writeDb$);
    const [created] = await writeDb
      .insert(socialKitDownloadJobs)
      .values({
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runId(args.auth),
        publicBrand: args.publicBrand,
        request: args.body,
      })
      .returning();
    signal.throwIfAborted();
    if (!created) {
      throw new Error("Failed to create SocialKit download job");
    }

    const processing = await startAndPersistProviderJob(
      writeDb,
      created,
      accessKey,
      args.body,
    );
    signal.throwIfAborted();
    if (!processing) {
      return errorResponse(
        502,
        "SocialKit could not start the download",
        "SOCIALKIT_DOWNLOAD_START_FAILED",
      );
    }

    return { status: 202, body: responseForJob(processing) };
  },
);

export const getSocialKitDownload$ = command(
  async (
    { set },
    args: {
      readonly downloadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<SocialKitDownloadResponse | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select()
      .from(socialKitDownloadJobs)
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.downloadId),
          eq(socialKitDownloadJobs.orgId, args.orgId),
          eq(socialKitDownloadJobs.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
    return job ? responseForJob(job) : null;
  },
);

const claimSocialKitDownload$ = command(
  async (
    { set },
    downloadId: string,
    signal: AbortSignal,
  ): Promise<DownloadJob | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        claimExpiresAt: sql`now() + interval '15 minutes'`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, downloadId),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
          or(
            isNull(socialKitDownloadJobs.claimExpiresAt),
            lt(socialKitDownloadJobs.claimExpiresAt, nowDate()),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return job ?? null;
  },
);

type ProviderReady = z.infer<typeof providerReadySchema>;

function safeProviderResult(ready: ProviderReady) {
  const thumbnail = providerThumbnailSchema.safeParse(ready.thumbnail);
  const downloadUrl = new URL(ready.downloadUrl);
  downloadUrl.hash = "";
  const thumbnailUrl = thumbnail.success ? new URL(thumbnail.data) : null;
  if (thumbnailUrl) {
    thumbnailUrl.hash = "";
  }
  const safeThumbnail =
    thumbnail.success && thumbnailUrl?.href !== downloadUrl.href
      ? thumbnail.data
      : undefined;
  return {
    durationSeconds: ready.durationSeconds,
    fileSizeMB: ready.fileSizeMB,
    creditsCost: ready.creditsCost,
    ...(typeof ready.title === "string" && ready.title.length <= 1000
      ? { title: ready.title }
      : {}),
    ...(safeThumbnail ? { thumbnail: safeThumbnail } : {}),
  };
}

const settleSocialKitDownloadUsage$ = command(
  async (
    { set },
    args: { readonly job: DownloadJob; readonly quantity: number },
    signal: AbortSignal,
  ): Promise<number> => {
    if (args.job.creditsCharged !== null) {
      return args.job.creditsCharged;
    }
    return await set(
      recordManagedUsage$,
      {
        actor: {
          orgId: args.job.orgId,
          userId: args.job.userId,
          ...(args.job.runId ? { runId: args.job.runId } : {}),
        },
        resource: {
          kind: "social",
          provider: "socialkit",
          category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
          quantity: args.quantity,
        },
        label: "SocialKit download",
        idempotencyKey: usageIdempotencyKey(args.job.id),
      },
      signal,
    );
  },
);

const persistAndSettleSocialKitDownloadUsage$ = command(
  async (
    { set },
    args: {
      readonly job: DownloadJob;
      readonly providerResult: NonNullable<DownloadJob["providerResult"]>;
    },
    signal: AbortSignal,
  ): Promise<DownloadJob> => {
    const writeDb = set(writeDb$);
    const [readyJob] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        providerResult: args.providerResult,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.job.id),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!readyJob) {
      throw new Error("Failed to persist SocialKit ready metadata");
    }

    const creditsCharged = await set(
      settleSocialKitDownloadUsage$,
      { job: readyJob, quantity: args.providerResult.creditsCost },
      signal,
    );
    const [materializing] = await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "materializing",
        creditsCharged,
        error: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(socialKitDownloadJobs.id, args.job.id),
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!materializing) {
      throw new Error("Failed to persist SocialKit usage settlement");
    }
    return materializing;
  },
);

const materializeSocialKitArtifact$ = command(
  async (
    { set },
    args: {
      readonly job: DownloadJob;
      readonly ready: ProviderReady;
      readonly providerResult: NonNullable<DownloadJob["providerResult"]>;
    },
    signal: AbortSignal,
  ): Promise<NonNullable<DownloadJob["artifact"]>> => {
    const filename = `socialkit-${args.job.id.slice(0, 8)}.${args.job.request.format}`;
    const contentType =
      args.job.request.format === "mp4" ? "video/mp4" : "audio/mp4";
    const existing = await set(
      resolveArtifactObject$,
      {
        userId: args.job.userId,
        id: args.job.id,
        filenameHint: filename,
        variant: "socialkit",
      },
      signal,
    );
    let stored: {
      readonly key: string;
      readonly url: string;
      readonly sizeBytes: number;
    };
    if (existing) {
      stored = {
        key: existing.key,
        url: existing.url,
        sizeBytes: existing.size,
      };
    } else {
      const location = await set(
        allocateArtifactObject$,
        {
          userId: args.job.userId,
          id: args.job.id,
          variant: "socialkit",
          filename,
          publicBrand: args.job.publicBrand,
        },
        signal,
      );
      const sizeBytes = await set(
        streamDownloadToArtifact$,
        {
          downloadUrl: args.ready.downloadUrl,
          bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
          key: location.key,
          contentType,
          metadata: location.metadata,
        },
        signal,
      );
      stored = { key: location.key, url: location.url, sizeBytes };
    }
    const artifact = {
      id: args.job.id,
      url: stored.url,
      filename,
      contentType,
      sizeBytes: stored.sizeBytes,
    };
    await set(
      recordWebUploadedFile$,
      {
        runId: args.job.runId ?? undefined,
        externalId: artifact.id,
        userId: args.job.userId,
        orgId: args.job.orgId,
        filename: artifact.filename,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        url: artifact.url,
        s3Key: stored.key,
        publicBrand: args.job.publicBrand,
        metadata: {
          provider: "socialkit",
          providerJobId: args.job.providerJobId,
          platform: args.job.request.platform,
          durationSeconds: args.providerResult.durationSeconds,
          creditsCost: args.providerResult.creditsCost,
        },
      },
      signal,
    );
    return artifact;
  },
);

const completeReadySocialKitDownload$ = command(
  async (
    { set },
    args: { readonly job: DownloadJob; readonly ready: ProviderReady },
    signal: AbortSignal,
  ): Promise<void> => {
    const providerResult =
      args.job.providerResult ?? safeProviderResult(args.ready);
    const settledJob = await set(
      persistAndSettleSocialKitDownloadUsage$,
      { job: args.job, providerResult },
      AbortSignal.timeout(READY_SETTLEMENT_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const artifact = await set(
      materializeSocialKitArtifact$,
      { job: settledJob, ready: args.ready, providerResult },
      signal,
    );
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "completed",
        providerResult,
        creditsCharged: settledJob.creditsCharged,
        artifact,
        error: null,
        claimExpiresAt: null,
        updatedAt: nowDate(),
        completedAt: nowDate(),
      })
      .where(eq(socialKitDownloadJobs.id, args.job.id));
  },
);

async function recordProcessingPoll(
  writeDb: Db,
  job: DownloadJob,
): Promise<void> {
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "processing",
      error: null,
      retryCount: 0,
      claimExpiresAt: null,
      updatedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
}

async function recordProviderFailure(
  writeDb: Db,
  job: DownloadJob,
  signal: AbortSignal,
  invalidResponse = false,
): Promise<void> {
  if (job.creditsCharged !== null) {
    await deferClaimedJob(writeDb, job, signal);
    return;
  }
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "provider_failed",
      error: {
        code: invalidResponse
          ? "SOCIALKIT_INVALID_DOWNLOAD_RESPONSE"
          : "SOCIALKIT_DOWNLOAD_FAILED",
        message: invalidResponse
          ? "SocialKit returned invalid download metadata"
          : "SocialKit could not prepare the download",
      },
      claimExpiresAt: null,
      updatedAt: nowDate(),
      completedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
}

export const reconcileSocialKitDownload$ = command(
  async (
    { set },
    downloadId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return false;
    }
    let job = await set(claimSocialKitDownload$, downloadId, signal);
    const providerJobId = job?.providerJobId;
    if (!job || !providerJobId) {
      return false;
    }
    const writeDb = set(writeDb$);
    if (job.providerResult && job.creditsCharged === null) {
      const recovered = await settle(
        set(
          persistAndSettleSocialKitDownloadUsage$,
          { job, providerResult: job.providerResult },
          AbortSignal.timeout(READY_SETTLEMENT_TIMEOUT_MS),
        ),
      );
      if (signal.aborted) {
        await settleIncludingAbort(
          deferClaimedJob(
            writeDb,
            job,
            AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MS),
          ),
        );
      }
      signal.throwIfAborted();
      if (!recovered.ok) {
        await deferClaimedJob(writeDb, job, signal);
        signal.throwIfAborted();
        return true;
      }
      job = recovered.value;
    }
    return await onRejection(
      (async (): Promise<boolean> => {
        const poll = await settle(
          pollProviderJob(accessKey, providerJobId, signal),
        );
        signal.throwIfAborted();
        if (!poll.ok) {
          await deferClaimedJob(writeDb, job, signal);
          return true;
        }
        if (poll.value.status === "processing") {
          if (job.creditsCharged === null) {
            await recordProcessingPoll(writeDb, job);
          } else {
            await deferClaimedJob(writeDb, job, signal);
          }
          signal.throwIfAborted();
          return true;
        }
        if (poll.value.status === "failed") {
          await recordProviderFailure(writeDb, job, signal);
          signal.throwIfAborted();
          return true;
        }
        if (poll.value.status === "invalid") {
          await recordProviderFailure(writeDb, job, signal, true);
          signal.throwIfAborted();
          return true;
        }
        if (!readyMetadataIsValid(job, poll.value.ready)) {
          await recordProviderFailure(writeDb, job, signal, true);
          signal.throwIfAborted();
          return true;
        }
        const completed = await settle(
          set(
            completeReadySocialKitDownload$,
            { job, ready: poll.value.ready },
            signal,
          ),
        );
        signal.throwIfAborted();
        if (!completed.ok) {
          await deferClaimedJob(writeDb, job, signal);
          return true;
        }
        return true;
      })(),
      async () => {
        if (!signal.aborted) {
          return;
        }
        await settleIncludingAbort(
          deferClaimedJob(
            writeDb,
            job,
            AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MS),
          ),
        );
      },
    );
  },
);

export const reconcileSocialKitDownloads$ = command(
  async (
    { set },
    args: { readonly candidateIds?: readonly string[] },
    signal: AbortSignal,
  ): Promise<number> => {
    const writeDb = set(writeDb$);
    const candidateScope = args.candidateIds
      ? inArray(socialKitDownloadJobs.id, args.candidateIds)
      : undefined;
    const staleCandidates = await writeDb
      .select({ id: socialKitDownloadJobs.id })
      .from(socialKitDownloadJobs)
      .where(
        and(
          eq(socialKitDownloadJobs.status, "submitting"),
          lt(
            socialKitDownloadJobs.createdAt,
            sql`now() - interval '15 minutes'`,
          ),
          candidateScope,
        ),
      )
      .orderBy(socialKitDownloadJobs.createdAt)
      .limit(RECONCILE_BATCH_SIZE);
    signal.throwIfAborted();
    const staleSubmissions =
      staleCandidates.length === 0
        ? []
        : await writeDb
            .update(socialKitDownloadJobs)
            .set({
              status: "provider_failed",
              error: {
                code: "SOCIALKIT_DOWNLOAD_START_INTERRUPTED",
                message: "The SocialKit download start was interrupted",
              },
              updatedAt: nowDate(),
              completedAt: nowDate(),
            })
            .where(
              and(
                inArray(
                  socialKitDownloadJobs.id,
                  staleCandidates.map((candidate) => {
                    return candidate.id;
                  }),
                ),
                eq(socialKitDownloadJobs.status, "submitting"),
              ),
            )
            .returning({ id: socialKitDownloadJobs.id });
    signal.throwIfAborted();
    const activeLimit = RECONCILE_BATCH_SIZE - staleSubmissions.length;
    if (activeLimit === 0) {
      return staleSubmissions.length;
    }
    const jobs = await writeDb
      .select({ id: socialKitDownloadJobs.id })
      .from(socialKitDownloadJobs)
      .where(
        and(
          inArray(socialKitDownloadJobs.status, ACTIVE_STATUSES),
          or(
            isNull(socialKitDownloadJobs.claimExpiresAt),
            lt(socialKitDownloadJobs.claimExpiresAt, nowDate()),
          ),
          candidateScope,
        ),
      )
      .orderBy(socialKitDownloadJobs.updatedAt)
      .limit(activeLimit);
    signal.throwIfAborted();
    let processed = staleSubmissions.length;
    for (const job of jobs) {
      if (await set(reconcileSocialKitDownload$, job.id, signal)) {
        processed += 1;
      }
    }
    return processed;
  },
);
