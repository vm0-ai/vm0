import {
  compatibleStoredExecutionContextSchema,
  type ConnectorRuntimeTarget,
} from "@vm0/api-contracts/contracts/runners";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { and, eq, type SQL } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import { publishConnectorRuntimeSyncToRunnerGroup } from "../external/realtime";
import { settle } from "../utils";

const L = logger("CustomConnectorRuntimeWakeup");

interface CustomConnectorRuntimeWakeupScope {
  readonly orgId: string;
  readonly userId?: string;
  readonly agentId?: string;
}

interface CustomConnectorRuntimeWakeupArgs {
  readonly db: ReadonlyDb;
  readonly scope: CustomConnectorRuntimeWakeupScope;
  readonly customConnectorIds: readonly string[];
}

interface CustomConnectorRuntimeWakeup {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>;
}

async function publishCustomConnectorRuntimeSyncWakeupsInner(
  args: CustomConnectorRuntimeWakeupArgs,
): Promise<void> {
  const customConnectorIds = [...new Set(args.customConnectorIds)];
  if (customConnectorIds.length === 0) {
    return;
  }

  const conditions: SQL[] = [
    eq(agentRuns.orgId, args.scope.orgId),
    eq(agentRuns.status, "running"),
  ];
  if (args.scope.userId !== undefined) {
    conditions.push(eq(agentRuns.userId, args.scope.userId));
  }
  if (args.scope.agentId !== undefined) {
    conditions.push(eq(agentSessions.agentComposeId, args.scope.agentId));
  }
  const rows = await args.db
    .select({
      runId: agentRuns.id,
      runnerGroup: agentRuns.runnerGroup,
      executionContext: runnerJobQueue.executionContext,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(runnerJobQueue, eq(runnerJobQueue.runId, agentRuns.id))
    .where(and(...conditions));

  const affected = new Set(customConnectorIds);
  const wakeups: CustomConnectorRuntimeWakeup[] = [];
  const wakeupKeys = new Set<string>();
  let runnerFilteredRunCount = 0;
  let skippedStoredContextCount = 0;
  for (const row of rows) {
    if (!row.runnerGroup) {
      continue;
    }
    if (row.executionContext === null) {
      runnerFilteredRunCount += 1;
      for (const customConnectorId of affected) {
        const wakeupKey = `${row.runId}:${customConnectorId}`;
        if (wakeupKeys.has(wakeupKey)) {
          continue;
        }
        wakeupKeys.add(wakeupKey);
        wakeups.push({
          runId: row.runId,
          runnerGroup: row.runnerGroup,
          target: { kind: "custom", customConnectorId },
        });
      }
      continue;
    }
    const parsed = compatibleStoredExecutionContextSchema.safeParse(
      row.executionContext,
    );
    if (!parsed.success || parsed.data.connectorRuntimeTargets === undefined) {
      skippedStoredContextCount += 1;
      continue;
    }
    for (const target of parsed.data.connectorRuntimeTargets) {
      if (target.kind === "custom" && affected.has(target.customConnectorId)) {
        const wakeupKey = `${row.runId}:${target.customConnectorId}`;
        if (wakeupKeys.has(wakeupKey)) {
          continue;
        }
        wakeupKeys.add(wakeupKey);
        wakeups.push({
          runId: row.runId,
          runnerGroup: row.runnerGroup,
          target: {
            kind: "custom",
            customConnectorId: target.customConnectorId,
          },
        });
      }
    }
  }

  const outcomes = await Promise.allSettled(
    wakeups.map(async (wakeup) => {
      await publishConnectorRuntimeSyncToRunnerGroup(
        wakeup.runnerGroup,
        wakeup.runId,
        wakeup.target,
      );
    }),
  );
  const failed = outcomes.filter((outcome) => {
    return outcome.status === "rejected";
  }).length;
  L.debug("Published Custom connector runtime sync wakeups", {
    orgId: args.scope.orgId,
    scopedToUser: args.scope.userId !== undefined,
    scopedToAgent: args.scope.agentId !== undefined,
    targetCount: customConnectorIds.length,
    examinedRunCount: rows.length,
    runnerFilteredRunCount,
    skippedStoredContextCount,
    matchedWakeupCount: wakeups.length,
    publishedWakeupCount: wakeups.length - failed,
    failedWakeupCount: failed,
  });
}

export async function publishCustomConnectorRuntimeSyncWakeups(
  args: CustomConnectorRuntimeWakeupArgs,
): Promise<void> {
  const result = await settle(
    publishCustomConnectorRuntimeSyncWakeupsInner(args),
  );
  if (!result.ok) {
    L.warn("Failed to publish Custom connector runtime sync wakeups", {
      orgId: args.scope.orgId,
      scopedToUser: args.scope.userId !== undefined,
      scopedToAgent: args.scope.agentId !== undefined,
      targetCount: new Set(args.customConnectorIds).size,
      error: result.error,
    });
  }
}
