/**
 * Zero API - Queue Position Endpoint
 *
 * GET /api/zero/queue-position?runId={runId}
 * Returns the position of a queued run within its org queue.
 */
import { NextResponse } from "next/server";
import { eq, and, lte } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrgOrNull } from "../../../../src/lib/zero/org/resolve-org";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";

export async function GET(request: Request) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId } = authCtx;

  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return NextResponse.json(
      { error: { message: "runId is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const org = await resolveOrgOrNull(authCtx);

  // Verify the run belongs to this user and org
  const [run] = await globalThis.services.db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, userId),
        ...(org ? [eq(agentRuns.orgId, org.orgId)] : []),
      ),
    )
    .limit(1);

  if (!run) {
    return NextResponse.json(
      { error: { message: "Run not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Find this run's queue entry
  const [queueEntry] = await globalThis.services.db
    .select({ createdAt: agentRunQueue.createdAt })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);

  if (!queueEntry) {
    // Not in queue (already dequeued or never queued)
    return NextResponse.json({ position: 0, total: 0 });
  }

  // Count how many runs in the same org are ahead (created before this one)
  const ahead = await globalThis.services.db
    .select({ runId: agentRunQueue.runId })
    .from(agentRunQueue)
    .where(
      and(
        eq(agentRunQueue.orgId, run.orgId),
        lte(agentRunQueue.createdAt, queueEntry.createdAt),
      ),
    );

  return NextResponse.json({
    position: ahead.length,
    total: ahead.length,
  });
}
