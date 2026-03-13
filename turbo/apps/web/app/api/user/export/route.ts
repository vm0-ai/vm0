import { NextResponse, after } from "next/server";
import { eq, and, gt, inArray } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { exportJobs } from "../../../../src/db/schema/export-job";
import { executeExportJob } from "../../../../src/lib/export/export-service";

// 24 hours in milliseconds
const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

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
  const { org } = await resolveOrg(userId);
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
