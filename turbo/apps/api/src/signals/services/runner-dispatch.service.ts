import { publishRunnerJobNotification } from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { now } from "../../lib/time";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import {
  runnerReuseKeyTelemetryKind,
  runnerReusePreferenceLookupError,
  resolveRunnerReusePreference,
} from "./runner-reuse-preference";
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
  let preferenceLookupSucceeded = true;
  const reusePreference =
    (await tapError(
      resolveRunnerReusePreference({
        db,
        runnerGroup: args.runnerGroup,
        profile: args.profile,
        reuseKey: args.reuseKey,
        historyGenerationRunId: args.historyGenerationRunId,
        createdAt: args.createdAt,
        currentDate,
      }),
      (error) => {
        preferenceLookupSucceeded = false;
        L.warn(
          "Failed to resolve runner reuse preference for job notification",
          {
            runId: args.runId,
            runnerGroup: args.runnerGroup,
            profile: args.profile,
            error,
          },
        );
      },
    )) ?? runnerReusePreferenceLookupError();
  const preferenceFinishedAt = now();
  const publishStartedAt = now();
  const published = await publishRunnerJobNotification(
    args.runnerGroup,
    args.runId,
    args.profile,
    {
      reuseKey: args.reuseKey,
      cliAgentSessionId: args.cliAgentSessionId,
      historyGenerationRunId: args.historyGenerationRunId,
      runnerPreference: reusePreference.runnerPreference,
      runnerPreferenceResolution: reusePreference.outcome,
    },
  );
  const publishFinishedAt = now();

  const dimensions: Record<string, string> = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    notification_target: "broadcast",
    runner_preference_resolution: reusePreference.outcome,
    reuse_key_kind: runnerReuseKeyTelemetryKind(args.reuseKey),
  };
  if (args.historyGenerationRunId) {
    dimensions.history_generation_run_id = args.historyGenerationRunId;
  }
  // Queue-relative actions are cumulative boundaries. Preference lookup and
  // publish durations are nested children and must not be added to them.
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
      durationMs: Math.max(0, preferenceFinishedAt - notificationEnteredAt),
      success: preferenceLookupSucceeded,
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
