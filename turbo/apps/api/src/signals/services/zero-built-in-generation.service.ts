import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  builtInGenerationJobs,
  type BuiltInGenerationError,
  type BuiltInGenerationType,
} from "@vm0/db/schema/built-in-generation-job";
import type { ZeroBuiltInGenerationResponse } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishBuiltInGenerationChanged } from "../external/realtime";
import { safeAsync } from "../utils";

const L = logger("ZeroBuiltInGeneration");

interface CreateBuiltInGenerationJobArgs {
  readonly generationId: string;
  readonly type: BuiltInGenerationType;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly request: Record<string, unknown>;
}

interface BuiltInGenerationJobRow {
  readonly id: string;
  readonly type: BuiltInGenerationType;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly userId: string;
  readonly result: unknown;
  readonly error: BuiltInGenerationError | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function publishJobSafely(job: BuiltInGenerationJobRow): Promise<void> {
  const payload = serializeBuiltInGenerationJob(job);
  const result = await safeAsync(async () => {
    await publishBuiltInGenerationChanged(job.userId, job.id, payload);
  });
  if ("error" in result) {
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
    return job ? serializeBuiltInGenerationJob(job) : null;
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
      .where(eq(builtInGenerationJobs.id, generationId));
    signal.throwIfAborted();
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
      .where(eq(builtInGenerationJobs.id, args.generationId))
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
      .where(eq(builtInGenerationJobs.id, args.generationId))
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
