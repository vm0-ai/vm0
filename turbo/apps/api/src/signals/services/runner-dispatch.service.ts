import { publishRunnerJobNotification } from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { now } from "../external/time";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import {
  runnerReuseKeyTelemetryKind,
  runnerSessionAffinityLookupError,
  runnerSessionAffinityProtection,
  runnerSessionAffinityTelemetryResource,
} from "./runner-session-affinity";
import { tapError } from "../utils";

const L = logger("RunnerDispatch");

export async function notifyRunnerJob(
  db: Pick<Db, "select">,
  args: {
    readonly runnerGroup: string;
    readonly runId: string;
    readonly profile: string;
    readonly reuseKey: string | null;
    readonly cliAgentSessionId: string | null;
    readonly historyGenerationRunId: string | undefined;
    readonly createdAt: Date;
  },
): Promise<boolean> {
  const notificationEnteredAt = now();
  const currentDate = new Date(notificationEnteredAt);
  let affinityLookupSucceeded = true;
  const affinity =
    (await tapError(
      runnerSessionAffinityProtection({
        db,
        runnerGroup: args.runnerGroup,
        profile: args.profile,
        reuseKey: args.reuseKey,
        historyGenerationRunId: args.historyGenerationRunId,
        createdAt: args.createdAt,
        currentDate,
      }),
      (error) => {
        affinityLookupSucceeded = false;
        L.warn(
          "Failed to resolve runner session affinity for job notification",
          {
            runId: args.runId,
            runnerGroup: args.runnerGroup,
            profile: args.profile,
            error,
          },
        );
      },
    )) ?? runnerSessionAffinityLookupError();
  const affinityFinishedAt = now();
  const publishStartedAt = now();
  const published = await publishRunnerJobNotification(
    args.runnerGroup,
    args.runId,
    args.profile,
    {
      reuseKey: args.reuseKey,
      cliAgentSessionId: args.cliAgentSessionId,
      historyGenerationAffinityProtectedUntil:
        affinity.historyGenerationProtectedUntil?.toISOString() ?? null,
      affinityProtectedUntil: affinity.protectedUntil?.toISOString() ?? null,
      sessionAffinityResource: affinity.resource,
      historyGenerationRunId: args.historyGenerationRunId,
    },
  );
  const publishFinishedAt = now();

  const dimensions = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    notification_target: "broadcast",
    session_affinity: affinity.status,
    session_affinity_resource: runnerSessionAffinityTelemetryResource(affinity),
    history_generation_affinity: affinity.historyGenerationStatus,
    reuse_key_kind: runnerReuseKeyTelemetryKind(args.reuseKey),
  };
  // Queue-relative actions are cumulative boundaries. Affinity and publish
  // durations are nested children and must not be added to those boundaries.
  recordSandboxOperations([
    {
      sandboxType: "runner",
      actionType: "runner_notification_queue_to_entry",
      durationMs: Math.max(0, notificationEnteredAt - args.createdAt.getTime()),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_notification_affinity_lookup",
      durationMs: Math.max(0, affinityFinishedAt - notificationEnteredAt),
      success: affinityLookupSucceeded,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_notification_queue_to_publish_start",
      durationMs: Math.max(0, publishStartedAt - args.createdAt.getTime()),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_notification_realtime_publish",
      durationMs: Math.max(0, publishFinishedAt - publishStartedAt),
      success: published,
      runId: args.runId,
      dimensions,
    },
  ]);

  return published;
}
