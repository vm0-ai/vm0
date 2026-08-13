import {
  connectorRuntimeTargetKey,
  type ConnectorRuntimeTarget,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { and, eq, isNotNull, type SQL } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import { publishConnectorRuntimeSyncToRunnerGroup } from "../external/realtime";
import { settle } from "../utils";

const L = logger("ConnectorRuntimeWakeup");

interface ConnectorRuntimeWakeupScope {
  readonly orgId: string;
  readonly userId?: string;
  readonly agentId?: string;
}

interface ConnectorRuntimeWakeupArgs {
  readonly db: ReadonlyDb;
  readonly scope: ConnectorRuntimeWakeupScope;
  readonly targets: readonly ConnectorRuntimeTarget[];
}

/**
 * Treats a committed mutation and its best-effort wakeup as one cancellation
 * boundary. Callers may observe request cancellation only after this returns.
 */
export async function commitConnectorRuntimeMutation<T>(
  commit: Promise<T>,
  wakeupForResult: (result: T) => ConnectorRuntimeWakeupArgs | undefined,
): Promise<T> {
  const result = await commit;
  const wakeup = wakeupForResult(result);
  if (wakeup) {
    await publishConnectorRuntimeSyncWakeups(wakeup);
  }
  return result;
}

interface ConnectorRuntimeWakeup {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly target: ConnectorRuntimeTarget;
}

function uniqueConnectorRuntimeTargets(
  targets: readonly ConnectorRuntimeTarget[],
): readonly ConnectorRuntimeTarget[] {
  const targetsByKey = new Map<string, ConnectorRuntimeTarget>();
  for (const target of targets) {
    targetsByKey.set(connectorRuntimeTargetKey(target), target);
  }
  return [...targetsByKey.values()];
}

async function publishConnectorRuntimeSyncWakeupsInner(
  args: ConnectorRuntimeWakeupArgs,
): Promise<void> {
  const targets = uniqueConnectorRuntimeTargets(args.targets);
  if (targets.length === 0) {
    return;
  }

  const conditions: SQL[] = [
    eq(agentRuns.orgId, args.scope.orgId),
    eq(agentRuns.status, "running"),
    isNotNull(agentRuns.runnerGroup),
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
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(and(...conditions));

  const wakeups: ConnectorRuntimeWakeup[] = [];
  const wakeupKeys = new Set<string>();
  for (const row of rows) {
    if (!row.runnerGroup) {
      continue;
    }
    for (const target of targets) {
      const targetKey = connectorRuntimeTargetKey(target);
      const wakeupKey = `${row.runId}:${targetKey}`;
      if (wakeupKeys.has(wakeupKey)) {
        continue;
      }
      wakeupKeys.add(wakeupKey);
      wakeups.push({
        runId: row.runId,
        runnerGroup: row.runnerGroup,
        target,
      });
    }
  }

  const outcomes = await Promise.all(
    wakeups.map(async (wakeup) => {
      const outcome = await settle(
        publishConnectorRuntimeSyncToRunnerGroup(
          wakeup.runnerGroup,
          wakeup.runId,
          wakeup.target,
        ),
      );
      return { wakeup, outcome };
    }),
  );
  let failedWakeupCount = 0;
  let firstFailure:
    | { readonly wakeup: ConnectorRuntimeWakeup; readonly error: unknown }
    | undefined;
  for (const { wakeup, outcome } of outcomes) {
    if (!outcome.ok) {
      failedWakeupCount += 1;
      firstFailure ??= { wakeup, error: outcome.error };
    }
  }

  if (firstFailure) {
    L.warn("Failed to publish connector runtime sync wakeups", {
      orgId: args.scope.orgId,
      scopedToUser: args.scope.userId !== undefined,
      scopedToAgent: args.scope.agentId !== undefined,
      targetCount: targets.length,
      examinedRunCount: rows.length,
      failedWakeupCount,
      firstFailedRunId: firstFailure.wakeup.runId,
      firstFailedRunnerGroup: firstFailure.wakeup.runnerGroup,
      firstFailedTarget: firstFailure.wakeup.target,
      error: firstFailure.error,
    });
  }
  L.debug("Published connector runtime sync wakeups", {
    orgId: args.scope.orgId,
    scopedToUser: args.scope.userId !== undefined,
    scopedToAgent: args.scope.agentId !== undefined,
    targetCount: targets.length,
    examinedRunCount: rows.length,
    matchedWakeupCount: wakeups.length,
    publishedWakeupCount: wakeups.length - failedWakeupCount,
    failedWakeupCount,
  });
}

/**
 * Best-effort post-commit notification. Once a runtime mutation commits,
 * callers must invoke this before observing request cancellation.
 */
export async function publishConnectorRuntimeSyncWakeups(
  args: ConnectorRuntimeWakeupArgs,
): Promise<void> {
  const result = await settle(publishConnectorRuntimeSyncWakeupsInner(args));
  if (!result.ok) {
    L.warn("Failed to discover connector runtime sync wakeups", {
      orgId: args.scope.orgId,
      scopedToUser: args.scope.userId !== undefined,
      scopedToAgent: args.scope.agentId !== undefined,
      targetCount: uniqueConnectorRuntimeTargets(args.targets).length,
      error: result.error,
    });
  }
}
