import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { executeSchedule } from "../../../../../src/lib/zero/schedule";
import { zeroAgentSchedules } from "../../../../../src/db/schema/zero-agent-schedule";
import { agentRuns } from "../../../../../src/db/schema/agent-run";

const bodySchema = z.object({
  scheduleId: z.string().uuid(),
});

export async function POST(request: Request) {
  const apiStartTime = Date.now();
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return Response.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { org } = await resolveOrg(authCtx);

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const { scheduleId } = parsed.data;

  // Look up the schedule, scoped to the user's org
  const [schedule] = await globalThis.services.db
    .select()
    .from(zeroAgentSchedules)
    .where(
      and(
        eq(zeroAgentSchedules.id, scheduleId),
        eq(zeroAgentSchedules.orgId, org.orgId),
      ),
    )
    .limit(1);

  if (!schedule) {
    return Response.json(
      { error: { message: "Schedule not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Skip if previous run is still active
  if (schedule.lastRunId) {
    const [lastRun] = await globalThis.services.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, schedule.lastRunId))
      .limit(1);

    if (
      lastRun &&
      (lastRun.status === "pending" || lastRun.status === "running")
    ) {
      return Response.json(
        {
          error: {
            message: "Previous run is still active",
            code: "CONFLICT",
          },
        },
        { status: 409 },
      );
    }
  }

  const runId = await executeSchedule(schedule, apiStartTime);

  return Response.json({ runId }, { status: 201 });
}
