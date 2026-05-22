import { command } from "ccstate";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import {
  builtInGenerationJobs,
  type BuiltInGenerationError,
  type BuiltInGenerationStatus,
  type BuiltInGenerationType,
} from "@vm0/db/schema/built-in-generation-job";
import type { ZeroBuiltInGenerationResponse } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishBuiltInGenerationChanged } from "../external/realtime";
import { settle } from "../utils";

const L = logger("ZeroBuiltInGeneration");

const ACTIVE_BUILT_IN_GENERATION_STATUSES = ["queued", "running"] as const;

const BUILT_IN_GENERATION_TIMEOUT_MS_BY_TYPE = {
  image: 15 * 60 * 1000,
  video: 30 * 60 * 1000,
  presentation: 60 * 60 * 1000,
  website: 60 * 60 * 1000,
} as const satisfies Record<BuiltInGenerationType, number>;

const BUILT_IN_GENERATION_TIMEOUT_ERROR: BuiltInGenerationError = Object.freeze(
  {
    message: "Generation timed out. Please try again.",
    code: "GENERATION_TIMEOUT",
  },
);

interface CreateBuiltInGenerationJobArgs {
  readonly generationId: string;
  readonly type: BuiltInGenerationType;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly request: Record<string, unknown>;
}

interface BuiltInGenerationRequestInternal {
  readonly admissionId?: string;
  readonly provider?: "openai" | "fal" | "byteplus";
  readonly providerJobId?: string;
  readonly providerStatusUrl?: string;
  readonly providerResponseUrl?: string;
  readonly providerTask?: string;
  readonly presentation?: unknown;
}

export interface BuiltInGenerationWebhookJob {
  readonly id: string;
  readonly type: BuiltInGenerationType;
  readonly status: BuiltInGenerationStatus;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | null;
  readonly request: Record<string, unknown>;
}

interface BuiltInGenerationJobRow {
  readonly id: string;
  readonly type: BuiltInGenerationType;
  readonly status: BuiltInGenerationStatus;
  readonly userId: string;
  readonly result: unknown;
  readonly error: BuiltInGenerationError | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

const BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY = "__builtInGeneration";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      return entry !== undefined;
    }),
  );
}

export function builtInGenerationRequestWithInternal(
  request: Record<string, unknown>,
  internal: BuiltInGenerationRequestInternal,
): Record<string, unknown> {
  return {
    ...request,
    [BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY]: compactObject({
      admissionId: internal.admissionId,
      provider: internal.provider,
      providerJobId: internal.providerJobId,
      providerStatusUrl: internal.providerStatusUrl,
      providerResponseUrl: internal.providerResponseUrl,
      providerTask: internal.providerTask,
      presentation: internal.presentation,
    }),
  };
}

export function readBuiltInGenerationRequestInternal(
  request: unknown,
): BuiltInGenerationRequestInternal {
  if (!isRecord(request)) {
    return {};
  }
  const value = request[BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY];
  if (!isRecord(value)) {
    return {};
  }
  return {
    admissionId:
      typeof value.admissionId === "string" ? value.admissionId : undefined,
    provider:
      value.provider === "openai" ||
      value.provider === "fal" ||
      value.provider === "byteplus"
        ? value.provider
        : undefined,
    providerJobId:
      typeof value.providerJobId === "string" ? value.providerJobId : undefined,
    providerStatusUrl:
      typeof value.providerStatusUrl === "string"
        ? value.providerStatusUrl
        : undefined,
    providerResponseUrl:
      typeof value.providerResponseUrl === "string"
        ? value.providerResponseUrl
        : undefined,
    providerTask:
      typeof value.providerTask === "string" ? value.providerTask : undefined,
    presentation: value.presentation,
  };
}

function serializeBuiltInGenerationJob(
  job: BuiltInGenerationJobRow,
): ZeroBuiltInGenerationResponse {
  return {
    generationId: job.id,
    type: job.type,
    status: job.status,
    ...(isRecord(job.result) ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.startedAt),
    completedAt: iso(job.completedAt),
  };
}

function isActiveBuiltInGenerationStatus(
  status: BuiltInGenerationStatus,
): status is (typeof ACTIVE_BUILT_IN_GENERATION_STATUSES)[number] {
  return ACTIVE_BUILT_IN_GENERATION_STATUSES.some((activeStatus) => {
    return activeStatus === status;
  });
}

function builtInGenerationTimeoutCutoff(
  type: BuiltInGenerationType,
  referenceTime: Date,
): Date {
  return new Date(
    referenceTime.getTime() - BUILT_IN_GENERATION_TIMEOUT_MS_BY_TYPE[type],
  );
}

function isStuckBuiltInGenerationJob(
  job: BuiltInGenerationJobRow & { readonly updatedAt: Date },
  referenceTime: Date,
): boolean {
  if (!isActiveBuiltInGenerationStatus(job.status)) {
    return false;
  }
  return (
    job.updatedAt <= builtInGenerationTimeoutCutoff(job.type, referenceTime)
  );
}

async function publishJobSafely(job: BuiltInGenerationJobRow): Promise<void> {
  const payload = serializeBuiltInGenerationJob(job);
  const result = await settle(
    publishBuiltInGenerationChanged(job.userId, job.id, payload),
  );
  if (!result.ok) {
    L.warn("Failed to publish built-in generation status", {
      generationId: job.id,
      error: result.error,
    });
  }
}

export const createBuiltInGenerationJob$ = command(
  async (
    { set },
    args: CreateBuiltInGenerationJobArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .insert(builtInGenerationJobs)
      .values({
        id: args.generationId,
        type: args.type,
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId ?? null,
        request: args.request,
      })
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    if (!job) {
      throw new Error("Failed to create built-in generation job");
    }
    return job.id;
  },
);

export const getBuiltInGenerationJob$ = command(
  async (
    { set },
    args: { readonly generationId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<ZeroBuiltInGenerationResponse | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        updatedAt: builtInGenerationJobs.updatedAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          eq(builtInGenerationJobs.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!job) {
      return null;
    }

    const currentTime = nowDate();
    if (!isStuckBuiltInGenerationJob(job, currentTime)) {
      return serializeBuiltInGenerationJob(job);
    }

    const cutoff = builtInGenerationTimeoutCutoff(job.type, currentTime);
    const [expiredJob] = await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "failed",
        error: BUILT_IN_GENERATION_TIMEOUT_ERROR,
        completedAt: currentTime,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          eq(builtInGenerationJobs.orgId, args.orgId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
          lte(builtInGenerationJobs.updatedAt, cutoff),
        ),
      )
      .returning({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      });
    signal.throwIfAborted();
    if (expiredJob) {
      await publishJobSafely(expiredJob);
      signal.throwIfAborted();
      return serializeBuiltInGenerationJob(expiredJob);
    }

    const [latestJob] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          eq(builtInGenerationJobs.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return latestJob ? serializeBuiltInGenerationJob(latestJob) : null;
  },
);

export const markBuiltInGenerationRunning$ = command(
  async ({ set }, generationId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "running",
        startedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, generationId),
          eq(builtInGenerationJobs.status, "queued"),
        ),
      );
    signal.throwIfAborted();
  },
);

export const mergeBuiltInGenerationJobInternal$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly internal: BuiltInGenerationRequestInternal;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select({ request: builtInGenerationJobs.request })
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, args.generationId))
      .limit(1);
    signal.throwIfAborted();
    if (!job || !isRecord(job.request)) {
      return;
    }

    const current = readBuiltInGenerationRequestInternal(job.request);
    await writeDb
      .update(builtInGenerationJobs)
      .set({
        request: builtInGenerationRequestWithInternal(job.request, {
          ...current,
          ...args.internal,
        }),
        updatedAt: nowDate(),
      })
      .where(eq(builtInGenerationJobs.id, args.generationId));
    signal.throwIfAborted();
  },
);

export const getBuiltInGenerationWebhookJob$ = command(
  async (
    { set },
    generationId: string,
    signal: AbortSignal,
  ): Promise<BuiltInGenerationWebhookJob | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        orgId: builtInGenerationJobs.orgId,
        userId: builtInGenerationJobs.userId,
        runId: builtInGenerationJobs.runId,
        request: builtInGenerationJobs.request,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          eq(builtInGenerationJobs.id, generationId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!job || !isRecord(job.request)) {
      return null;
    }
    return { ...job, request: job.request };
  },
);

export const refreshActiveBuiltInGenerationJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly type: BuiltInGenerationType;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const currentTime = nowDate();
    const cutoff = builtInGenerationTimeoutCutoff(args.type, currentTime);
    const [job] = await writeDb
      .update(builtInGenerationJobs)
      .set({ updatedAt: currentTime })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          eq(builtInGenerationJobs.type, args.type),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
          gt(builtInGenerationJobs.updatedAt, cutoff),
        ),
      )
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    return Boolean(job);
  },
);

export const completeBuiltInGenerationJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly result: object;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "completed",
        result: args.result,
        error: null,
        completedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
        ),
      )
      .returning({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      });
    signal.throwIfAborted();
    if (job) {
      await publishJobSafely(job);
    }
  },
);

export const failBuiltInGenerationJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly error: BuiltInGenerationError;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "failed",
        error: args.error,
        completedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
        ),
      )
      .returning({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      });
    signal.throwIfAborted();
    if (job) {
      await publishJobSafely(job);
    }
  },
);
