import { computed } from "ccstate";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type {
  UserExportJob,
  UserExportStatusResponse,
} from "@vm0/api-contracts/contracts/user-export";
import { exportJobs } from "@vm0/db/schema/export-job";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { nowDate } from "../external/time";

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_URL_EXPIRY_SECONDS = 3600;
const EXPORT_FILENAME = "vm0-data-export.zip";

type ExportJobStatus = UserExportJob["status"];

const EXPORT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const satisfies readonly ExportJobStatus[];

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
