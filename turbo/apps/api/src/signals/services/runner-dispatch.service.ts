import { publishRunnerJobNotification } from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { now, nowDate } from "../external/time";
import type { Db } from "../external/db";
import { runnerSessionAffinityProtection } from "./runner-session-affinity";

export async function notifyRunnerJob(
  db: Pick<Db, "select">,
  args: {
    readonly runnerGroup: string;
    readonly runId: string;
    readonly profile: string;
    readonly cliAgentSessionId: string | null;
  },
): Promise<boolean> {
  const publishStartedAt = now();
  const currentDate = nowDate();
  const affinity = await runnerSessionAffinityProtection({
    db,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    cliAgentSessionId: args.cliAgentSessionId,
    createdAt: currentDate,
    currentDate,
  });
  const published = await publishRunnerJobNotification(
    args.runnerGroup,
    args.runId,
    args.profile,
    {
      cliAgentSessionId: args.cliAgentSessionId,
      affinityProtectedUntil: affinity.protectedUntil?.toISOString() ?? null,
    },
  );
  const publishFinishedAt = now();

  const dimensions = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    notification_target: "broadcast",
    session_affinity: affinity.status,
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
