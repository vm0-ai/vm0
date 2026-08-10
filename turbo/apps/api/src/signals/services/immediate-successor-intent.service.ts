import type { ImmediateSuccessorIntentSignal } from "@vm0/api-contracts/contracts/runners";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import type { Db } from "../external/db";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { publishImmediateSuccessorIntentToRunnerGroup } from "../external/realtime";
import { tapError } from "../utils";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "./runner-reuse-preference";

const L = logger("ImmediateSuccessorIntent");

type ImmediateSuccessorEventClass =
  ImmediateSuccessorIntentSignal["eventClass"];

interface ImmediateSuccessorIntentSource {
  readonly group: string;
  readonly signal: Omit<ImmediateSuccessorIntentSignal, "action">;
}

export interface ImmediateSuccessorIntentHandle {
  revoke(): void;
}

interface ScheduleImmediateSuccessorIntentArgs {
  readonly db: Db;
  readonly predecessorRunId: string | undefined;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly intentId: string;
  readonly eventClass: ImmediateSuccessorEventClass;
}

type InvalidSourceReason =
  | "missing_source"
  | "source_not_completed"
  | "source_scope_mismatch"
  | "source_identity_missing"
  | "source_expired"
  | "lookup_error";

type IntentOutcome =
  | InvalidSourceReason
  | "valid"
  | "publish_started"
  | "published"
  | "publish_failed";

function intentDimensions(args: {
  readonly action: ImmediateSuccessorIntentSignal["action"];
  readonly eventClass: ImmediateSuccessorEventClass;
  readonly outcome: IntentOutcome;
}): Record<string, string> {
  return {
    immediate_successor_action: args.action,
    immediate_successor_event_class: args.eventClass,
    immediate_successor_outcome: args.outcome,
  };
}

function recordInvalidSource(args: {
  readonly predecessorRunId: string;
  readonly eventClass: ImmediateSuccessorEventClass;
  readonly decidedAtMs: number;
  readonly reason: InvalidSourceReason;
}): void {
  recordSandboxOperations([
    {
      sandboxType: "runner",
      actionType: "immediate_successor_intent_source_validation",
      durationMs: Math.max(0, now() - args.decidedAtMs),
      success: false,
      runId: args.predecessorRunId,
      dimensions: intentDimensions({
        action: "arm",
        eventClass: args.eventClass,
        outcome: args.reason,
      }),
    },
  ]);
}

function invalidIntentSource(
  args: {
    readonly predecessorRunId: string;
    readonly eventClass: ImmediateSuccessorEventClass;
    readonly decidedAtMs: number;
  },
  reason: InvalidSourceReason,
): null {
  recordInvalidSource({ ...args, reason });
  return null;
}

async function resolveIntentSource(
  args: ScheduleImmediateSuccessorIntentArgs & {
    readonly predecessorRunId: string;
    readonly decidedAt: Date;
  },
): Promise<ImmediateSuccessorIntentSource | null> {
  const loaded = await tapError(
    (async () => {
      const [source] = await args.db
        .select({
          status: agentRuns.status,
          completedAt: agentRuns.completedAt,
          orgId: agentRuns.orgId,
          runnerGroup: agentRuns.runnerGroup,
          runnerId: agentRuns.runnerId,
          runnerHeartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
          chatThreadId: zeroRuns.chatThreadId,
        })
        .from(agentRuns)
        .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
        .where(
          and(
            eq(agentRuns.id, args.predecessorRunId),
            eq(zeroRuns.chatThreadId, args.chatThreadId),
          ),
        )
        .limit(1);
      return source ?? null;
    })(),
    (error) => {
      L.warn("Failed to load immediate successor source", {
        predecessorRunId: args.predecessorRunId,
        eventClass: args.eventClass,
        error,
      });
    },
  );
  const decidedAtMs = args.decidedAt.getTime();
  const invalidArgs = {
    predecessorRunId: args.predecessorRunId,
    eventClass: args.eventClass,
    decidedAtMs,
  };
  if (loaded === undefined) {
    return invalidIntentSource(invalidArgs, "lookup_error");
  }
  if (!loaded) {
    return invalidIntentSource(invalidArgs, "missing_source");
  }
  if (loaded.status !== "completed" || !loaded.completedAt) {
    return invalidIntentSource(invalidArgs, "source_not_completed");
  }
  if (
    loaded.orgId !== args.orgId ||
    loaded.chatThreadId !== args.chatThreadId
  ) {
    return invalidIntentSource(invalidArgs, "source_scope_mismatch");
  }
  if (
    !loaded.runnerGroup ||
    !loaded.runnerId ||
    !loaded.runnerHeartbeatGeneration
  ) {
    return invalidIntentSource(invalidArgs, "source_identity_missing");
  }
  const expiresAt = new Date(
    loaded.completedAt.getTime() + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  if (expiresAt.getTime() <= decidedAtMs) {
    return invalidIntentSource(invalidArgs, "source_expired");
  }

  recordSandboxOperations([
    {
      sandboxType: "runner",
      actionType: "immediate_successor_intent_source_validation",
      durationMs: Math.max(0, now() - decidedAtMs),
      success: true,
      runId: args.predecessorRunId,
      dimensions: intentDimensions({
        action: "arm",
        eventClass: args.eventClass,
        outcome: "valid",
      }),
    },
    {
      sandboxType: "runner",
      actionType: "immediate_successor_intent_deadline_remaining",
      durationMs: Math.max(0, expiresAt.getTime() - decidedAtMs),
      success: true,
      runId: args.predecessorRunId,
      dimensions: intentDimensions({
        action: "arm",
        eventClass: args.eventClass,
        outcome: "valid",
      }),
    },
  ]);

  return {
    group: loaded.runnerGroup,
    signal: {
      predecessorRunId: args.predecessorRunId,
      intentId: args.intentId,
      runnerIdentity: {
        runnerId: loaded.runnerId,
        heartbeatGeneration: loaded.runnerHeartbeatGeneration,
      } satisfies ImmediateSuccessorIntentSignal["runnerIdentity"],
      eventClass: args.eventClass,
      decidedAt: args.decidedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
  };
}

async function publishIntentAction(args: {
  readonly source: ImmediateSuccessorIntentSource | null;
  readonly action: ImmediateSuccessorIntentSignal["action"];
  readonly predecessorRunId: string;
  readonly eventClass: ImmediateSuccessorEventClass;
  readonly decidedAtMs: number;
}): Promise<void> {
  if (!args.source) {
    return;
  }
  const publishStartedAt = now();
  const published = await publishImmediateSuccessorIntentToRunnerGroup({
    group: args.source.group,
    intent: { ...args.source.signal, action: args.action },
  });
  recordSandboxOperations([
    {
      sandboxType: "runner",
      actionType: "immediate_successor_intent_decision_to_publish",
      durationMs: Math.max(0, publishStartedAt - args.decidedAtMs),
      success: true,
      runId: args.predecessorRunId,
      dimensions: intentDimensions({
        action: args.action,
        eventClass: args.eventClass,
        outcome: "publish_started",
      }),
    },
    {
      sandboxType: "runner",
      actionType: "immediate_successor_intent_realtime_publish",
      durationMs: Math.max(0, now() - publishStartedAt),
      success: published,
      runId: args.predecessorRunId,
      dimensions: intentDimensions({
        action: args.action,
        eventClass: args.eventClass,
        outcome: published ? "published" : "publish_failed",
      }),
    },
  ]);
}

export function scheduleImmediateSuccessorIntent(
  args: ScheduleImmediateSuccessorIntentArgs,
): ImmediateSuccessorIntentHandle | undefined {
  if (!args.predecessorRunId) {
    return undefined;
  }
  const predecessorRunId = args.predecessorRunId;
  const decidedAt = nowDate();
  const source = resolveIntentSource({
    ...args,
    predecessorRunId,
    decidedAt,
  });
  const arm = (async () => {
    const resolved = await source;
    await publishIntentAction({
      source: resolved,
      action: "arm",
      predecessorRunId,
      eventClass: args.eventClass,
      decidedAtMs: decidedAt.getTime(),
    });
    return resolved;
  })();
  waitUntil(arm);

  return {
    revoke(): void {
      waitUntil(
        (async () => {
          const resolved = await arm;
          await publishIntentAction({
            source: resolved,
            action: "revoke",
            predecessorRunId,
            eventClass: args.eventClass,
            decidedAtMs: decidedAt.getTime(),
          });
        })(),
      );
    },
  };
}
