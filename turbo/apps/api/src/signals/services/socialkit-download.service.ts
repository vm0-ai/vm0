import { v5 as uuidv5 } from "uuid";

import {
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  socialKitDownloadFormatSchema,
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
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
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
const SOCIALKIT_DOWNLOAD_TIMEOUT_MS = 12 * 60_000;
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
  jobId: z.string().min(1),
  status: z.string().min(1),
});

const providerReadySchema = z.object({
  jobId: z.string().min(1),
  status: z.literal("ready"),
  downloadUrl: z.url().max(8192),
  durationSeconds: z.number().int().positive(),
  fileSizeMB: z.number().nonnegative(),
  creditsCost: z.number().int().positive(),
  quality: socialKitDownloadQualitySchema,
  format: socialKitDownloadFormatSchema,
  title: z.string().max(1000).optional(),
  thumbnail: z.url().max(4096).optional(),
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
          retryable: job.status === "artifact_failed",
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
    throw new Error("SocialKit returned an invalid download status");
  }
  if (result.body.status === "failed") {
    return { status: "failed" };
  }
  if (result.body.status !== "ready") {
    return { status: "processing" };
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
    const target = await validateScrapeTargetUrl(currentUrl);
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
      throw new Error("SocialKit artifact download failed");
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
      throw new Error("SocialKit artifact exceeds the 2 GiB limit");
    }

    const uploadId = await get(
      createMultipartS3Upload(
        args.bucket,
        args.key,
        args.contentType,
        args.metadata,
      ),
    );
    signal.throwIfAborted();
    const parts: MultipartS3Part[] = [];
    const reader = response.body.getReader();
    let chunks: Uint8Array[] = [];
    let bufferedBytes = 0;
    let totalBytes = 0;

    const uploadBuffered = async (): Promise<void> => {
      if (bufferedBytes === 0) {
        return;
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

    const streamed = await settle(
      (async (): Promise<number> => {
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
          completeMultipartS3Upload(args.bucket, args.key, uploadId, parts),
        );
        signal.throwIfAborted();
        return totalBytes;
      })(),
    );
    signal.throwIfAborted();
    reader.releaseLock();
    if (!streamed.ok) {
      await settle(
        get(abortMultipartS3Upload(args.bucket, args.key, uploadId)),
      );
      signal.throwIfAborted();
      throw streamed.error;
    }
    signal.throwIfAborted();
    return streamed.value;
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
    ready.quality !== job.request.quality ||
    ready.format !== job.request.format ||
    ready.durationSeconds > job.request.maxDuration ||
    ready.creditsCost !== expectedCredits ||
    ready.creditsCost > maximumCredits
  );
}

async function failClaimedJob(
  writeDb: Db,
  job: DownloadJob,
  signal: AbortSignal,
): Promise<void> {
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status: "artifact_failed",
      error: {
        code: "ARTIFACT_MATERIALIZATION_FAILED",
        message: "The artifact could not be materialized",
      },
      retryCount: sql`${socialKitDownloadJobs.retryCount} + 1`,
      claimExpiresAt: sql`now() + LEAST(30, ${socialKitDownloadJobs.retryCount} + 1) * interval '1 minute'`,
      updatedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
  signal.throwIfAborted();
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

    const started = await settle(
      startProviderJob(accessKey, args.body, signal),
    );
    signal.throwIfAborted();
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
      signal.throwIfAborted();
      return errorResponse(
        502,
        "SocialKit could not start the download",
        "SOCIALKIT_DOWNLOAD_START_FAILED",
      );
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
    signal.throwIfAborted();
    if (!processing) {
      throw new Error("Failed to persist SocialKit provider job");
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
  return {
    durationSeconds: ready.durationSeconds,
    fileSizeMB: ready.fileSizeMB,
    creditsCost: ready.creditsCost,
    ...(ready.title ? { title: ready.title } : {}),
    ...(ready.thumbnail ? { thumbnail: ready.thumbnail } : {}),
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
      },
      signal,
    );
    const location = existing
      ? null
      : await set(
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
    const sizeBytes = existing
      ? existing.size
      : await set(
          streamDownloadToArtifact$,
          {
            downloadUrl: args.ready.downloadUrl,
            bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
            key: location!.key,
            contentType,
            metadata: location!.metadata,
          },
          signal,
        );
    const artifact = {
      id: args.job.id,
      url: existing?.url ?? location!.url,
      filename,
      contentType,
      sizeBytes,
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
        s3Key: existing?.key ?? location!.key,
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
    const providerResult = safeProviderResult(args.ready);
    const creditsCharged = await set(
      settleSocialKitDownloadUsage$,
      { job: args.job, quantity: providerResult.creditsCost },
      signal,
    );
    const writeDb = set(writeDb$);
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "materializing",
        providerResult,
        creditsCharged,
        error: null,
        updatedAt: nowDate(),
      })
      .where(eq(socialKitDownloadJobs.id, args.job.id));
    signal.throwIfAborted();
    const artifact = await set(
      materializeSocialKitArtifact$,
      { job: args.job, ready: args.ready, providerResult },
      signal,
    );
    await writeDb
      .update(socialKitDownloadJobs)
      .set({
        status: "completed",
        providerResult,
        creditsCharged,
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
      claimExpiresAt: null,
      updatedAt: nowDate(),
    })
    .where(eq(socialKitDownloadJobs.id, job.id));
}

async function recordProviderFailure(
  writeDb: Db,
  job: DownloadJob,
  invalidResponse = false,
): Promise<void> {
  await writeDb
    .update(socialKitDownloadJobs)
    .set({
      status:
        job.creditsCharged === null ? "provider_failed" : "artifact_failed",
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
      completedAt: job.creditsCharged === null ? nowDate() : null,
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
    const job = await set(claimSocialKitDownload$, downloadId, signal);
    if (!job?.providerJobId) {
      return false;
    }
    const writeDb = set(writeDb$);
    const poll = await settle(
      pollProviderJob(accessKey, job.providerJobId, signal),
    );
    signal.throwIfAborted();
    if (!poll.ok) {
      await failClaimedJob(writeDb, job, signal);
      return false;
    }
    if (poll.value.status === "processing") {
      await recordProcessingPoll(writeDb, job);
      signal.throwIfAborted();
      return true;
    }
    if (poll.value.status === "failed") {
      await recordProviderFailure(writeDb, job);
      signal.throwIfAborted();
      return true;
    }
    if (poll.value.status === "invalid") {
      await recordProviderFailure(writeDb, job, true);
      signal.throwIfAborted();
      return true;
    }
    if (!readyMetadataIsValid(job, poll.value.ready)) {
      await recordProviderFailure(writeDb, job, true);
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
      await failClaimedJob(writeDb, job, signal);
      return false;
    }
    return true;
  },
);

export const reconcileSocialKitDownloads$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const writeDb = set(writeDb$);
    const staleSubmissions = await writeDb
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
          eq(socialKitDownloadJobs.status, "submitting"),
          lt(
            socialKitDownloadJobs.createdAt,
            sql`now() - interval '15 minutes'`,
          ),
        ),
      )
      .returning({ id: socialKitDownloadJobs.id });
    signal.throwIfAborted();
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
        ),
      )
      .orderBy(socialKitDownloadJobs.updatedAt)
      .limit(RECONCILE_BATCH_SIZE);
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
