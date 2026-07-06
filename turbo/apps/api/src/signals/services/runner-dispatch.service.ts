import { publishRunnerJobNotification } from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { now, nowDate } from "../external/time";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import {
  runnerSessionAffinityLookupError,
  runnerSessionAffinityProtection,
} from "./runner-session-affinity";
import { settle } from "../utils";

const L = logger("RunnerDispatch");

export async function notifyRunnerJob(
  db: Pick<Db, "select">,
  args: {
    readonly runnerGroup: string;
    readonly runId: string;
    readonly profile: string;
    readonly cliAgentSessionId: string | null;
    readonly createdAt: Date;
  },
): Promise<boolean> {
  const currentDate = nowDate();
  const affinityResult = await settle(
    runnerSessionAffinityProtection({
      db,
      runnerGroup: args.runnerGroup,
      profile: args.profile,
      cliAgentSessionId: args.cliAgentSessionId,
      createdAt: args.createdAt,
      currentDate,
    }),
  );
  const affinity = affinityResult.ok
    ? affinityResult.value
    : runnerSessionAffinityLookupError();
  if (!affinityResult.ok) {
    L.warn("Failed to resolve runner session affinity for job notification", {
      runId: args.runId,
      runnerGroup: args.runnerGroup,
      profile: args.profile,
      error: affinityResult.error,
    });
  }
  const publishStartedAt = now();
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
