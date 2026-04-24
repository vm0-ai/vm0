import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runnersHeartbeatContract } from "@vm0/core/contracts/runners";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../src/lib/init-services";
import { runnerState } from "../../../../src/db/schema/runner-state";
import { getRunnerAuth } from "../../../../src/lib/auth/runner-auth";
import { isOfficialRunnerGroup } from "../../../../src/lib/infra/run/runner-group";
import { lt } from "drizzle-orm";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const router = tsr.router(runnersHeartbeatContract, {
  heartbeat: async ({ body, headers }) => {
    initServices();

    const auth = await getRunnerAuth(headers.authorization);
    if (!auth) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    if (!isOfficialRunnerGroup(body.group)) {
      return createErrorResponse("BAD_REQUEST", "Invalid runner group");
    }

    const now = new Date();

    // Upsert runner state
    await globalThis.services.db
      .insert(runnerState)
      .values({
        runnerId: body.runnerId,
        runnerName: body.runnerName,
        runnerGroup: body.group,
        profiles: body.profiles,
        totalVcpu: body.totalVcpu,
        totalMemoryMb: body.totalMemoryMb,
        maxConcurrent: body.maxConcurrent,
        allocatedVcpu: body.allocatedVcpu,
        allocatedMemoryMb: body.allocatedMemoryMb,
        runningCount: body.runningCount,
        heldSessions: body.heldSessions,
        mode: body.mode,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: runnerState.runnerId,
        set: {
          runnerName: body.runnerName,
          runnerGroup: body.group,
          profiles: body.profiles,
          totalVcpu: body.totalVcpu,
          totalMemoryMb: body.totalMemoryMb,
          maxConcurrent: body.maxConcurrent,
          allocatedVcpu: body.allocatedVcpu,
          allocatedMemoryMb: body.allocatedMemoryMb,
          runningCount: body.runningCount,
          heldSessions: body.heldSessions,
          mode: body.mode,
          lastSeenAt: now,
        },
      });

    // Piggyback cleanup: remove stale runners (not seen for 5 minutes)
    await globalThis.services.db
      .delete(runnerState)
      .where(
        lt(
          runnerState.lastSeenAt,
          new Date(now.getTime() - STALE_THRESHOLD_MS),
        ),
      );

    return { status: 200 as const, body: { ok: true as const } };
  },
});

function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(runnersHeartbeatContract, router, {
  routeName: "runners.heartbeat",
  errorHandler,
});

export { handler as POST };
