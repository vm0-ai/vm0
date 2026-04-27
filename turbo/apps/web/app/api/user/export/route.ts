import { NextResponse, after } from "next/server";
import { eq, and, gt, inArray, desc } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { exportJobs } from "@vm0/db/schema/export-job";
import { executeExportJob } from "../../../../src/lib/zero/export/export-service";
import { generatePresignedUrl } from "../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../src/env";

// 24 hours in milliseconds
const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
// Presigned URL expiry for download (1 hour)
const DOWNLOAD_URL_EXPIRY_SECONDS = 3600;

export async function POST(request: Request) {
  initServices();

  // Authenticate user
  const authHeader = request.headers.get("authorization") ?? undefined;
  const ctx = await getAuthContext(authHeader);
  if (!ctx) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const { userId } = ctx;

  // Resolve orgId via resolveOrg (works for both Clerk sessions and CLI tokens)
  const { org } = await resolveOrg(ctx);
  const resolvedOrgId = org.orgId;

  const db = globalThis.services.db;

  // Check for existing active job (idempotency)
  const [existingActive] = await db
    .select({ id: exportJobs.id, status: exportJobs.status })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.userId, userId),
        inArray(exportJobs.status, ["pending", "running"]),
      ),
    )
    .limit(1);

  if (existingActive) {
    return NextResponse.json(
      { jobId: existingActive.id, status: existingActive.status },
      { status: 202 },
    );
  }

  // Rate limit: check for completed export within 24 hours
  const rateLimitCutoff = new Date(Date.now() - RATE_LIMIT_MS);
  const [recentExport] = await db
    .select({ id: exportJobs.id })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.userId, userId),
        eq(exportJobs.status, "completed"),
        gt(exportJobs.completedAt, rateLimitCutoff),
      ),
    )
    .limit(1);

  if (recentExport) {
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Export already completed within the last 24 hours",
        },
      },
      { status: 429 },
    );
  }

  // Insert new job
  const [newJob] = await db
    .insert(exportJobs)
    .values({
      userId,
      orgId: resolvedOrgId,
      status: "pending",
    })
    .returning({ id: exportJobs.id });

  if (!newJob) {
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to create export job",
        },
      },
      { status: 500 },
    );
  }

  const jobId = newJob.id;

  // Run export asynchronously
  after(async () => {
    await executeExportJob(jobId, userId, resolvedOrgId);
  });

  return NextResponse.json({ jobId, status: "pending" }, { status: 202 });
}

export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const ctx = await getAuthContext(authHeader);
  if (!ctx) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const { userId } = ctx;
  const db = globalThis.services.db;

  // Get the latest export job for this user
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

  // Determine canExport and nextExportAt
  const now = new Date();
  const rateLimitCutoff = new Date(now.getTime() - RATE_LIMIT_MS);
  const [recentCompleted] = await db
    .select({
      completedAt: exportJobs.completedAt,
    })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.userId, userId),
        eq(exportJobs.status, "completed"),
        gt(exportJobs.completedAt, rateLimitCutoff),
      ),
    )
    .limit(1);

  // Also check for active jobs (pending/running)
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
    return NextResponse.json({
      job: null,
      canExport: true,
      nextExportAt: null,
    });
  }

  // Generate a fresh presigned download URL if the job is completed and not expired
  let downloadUrl: string | null = null;
  if (
    latestJob.status === "completed" &&
    latestJob.s3Key &&
    latestJob.expiresAt &&
    latestJob.expiresAt > now
  ) {
    const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
    downloadUrl = await generatePresignedUrl(
      bucket,
      latestJob.s3Key,
      DOWNLOAD_URL_EXPIRY_SECONDS,
      "vm0-data-export.zip",
      true,
    );
  }

  return NextResponse.json({
    job: {
      id: latestJob.id,
      status: latestJob.status,
      createdAt: latestJob.createdAt.toISOString(),
      completedAt: latestJob.completedAt?.toISOString() ?? null,
      expiresAt: latestJob.expiresAt?.toISOString() ?? null,
      downloadUrl,
      error: latestJob.error,
    },
    canExport,
    nextExportAt,
  });
}
