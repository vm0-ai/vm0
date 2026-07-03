import { publishRunnerJobNotification } from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { now, nowDate } from "../external/time";
import { affinityProtectedUntil } from "./runner-session-affinity";

export async function notifyRunnerJob(args: {
  readonly runnerGroup: string;
  readonly runId: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
}): Promise<boolean> {
  const publishStartedAt = now();
  const protectedUntil = affinityProtectedUntil(
    args.cliAgentSessionId,
    nowDate(),
  );
  const published = await publishRunnerJobNotification(
    args.runnerGroup,
    args.runId,
    args.profile,
    {
      cliAgentSessionId: args.cliAgentSessionId,
      affinityProtectedUntil: protectedUntil?.toISOString() ?? null,
    },
  );
  const publishFinishedAt = now();

  const dimensions = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    notification_target: "broadcast",
  };
  recordSandboxOperations([
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
