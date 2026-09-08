import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { and, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import { publishSshInvalidationToRunnerGroup } from "../external/realtime";
import { settle } from "../utils";

const L = logger("SshRuntimeWakeup");

interface SshInvalidationScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId?: string;
  readonly connectionId: string | null;
}

/** Best-effort post-commit eviction. Deleted grants/connections must not filter out Runs. */
export async function publishSshRuntimeInvalidation(
  db: ReadonlyDb,
  scope: SshInvalidationScope,
): Promise<void> {
  const discovery = await settle(
    db
      .select({ runId: agentRuns.id, runnerGroup: agentRuns.runnerGroup })
      .from(agentRuns)
      .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
      .where(
        and(
          eq(agentRuns.orgId, scope.orgId),
          eq(agentRuns.userId, scope.userId),
          eq(agentRuns.status, "running"),
          isNotNull(agentRuns.runnerGroup),
          scope.agentId === undefined
            ? undefined
            : eq(agentSessions.agentId, scope.agentId),
        ),
      ),
  );
  if (!discovery.ok) {
    L.warn("Failed to discover SSH invalidation recipients", {
      ...scope,
      error: discovery.error,
    });
    return;
  }
  // Bound parallel publication to the affected active Runs.
  for (let offset = 0; offset < discovery.value.length; offset += 16) {
    await Promise.all(
      discovery.value.slice(offset, offset + 16).map(async (run) => {
        if (run.runnerGroup === null) {
          return;
        }
        const published = await settle(
          publishSshInvalidationToRunnerGroup(run.runnerGroup, {
            runId: run.runId,
            connectionId: scope.connectionId,
          }),
        );
        if (!published.ok) {
          L.warn("Failed to publish SSH invalidation", {
            ...scope,
            runId: run.runId,
            error: published.error,
          });
        }
      }),
    );
  }
}
