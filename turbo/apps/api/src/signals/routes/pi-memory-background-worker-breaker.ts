import { env } from "../../lib/env";
import { logger } from "../../lib/log";

const log = logger("PiMemoryBackgroundWorkerBreaker");

type PiMemoryBackgroundWorkerRoute = "stage1" | "phase2";

export function admitsPiMemoryBackgroundWorkerInvocation(
  route: PiMemoryBackgroundWorkerRoute,
): boolean {
  const enabled = env("PI_MEMORY_BACKGROUND_WORKERS_ENABLED") === "true";
  if (!enabled) {
    log.debug("Pi memory background worker invocation disabled", {
      route,
      outcome: "disabled",
    });
  }
  return enabled;
}
