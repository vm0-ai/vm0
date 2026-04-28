import { eq } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { publishUserSignal } from "../realtime/client";
import { logger } from "../../shared/logger";

const log = logger("run:realtime");

function runChangedTopic(runId: string): string {
  return `run:changed:${runId}`;
}

async function publishRunChangedForUser(
  userId: string,
  runId: string,
  payload: unknown = null,
): Promise<void> {
  await publishUserSignal([userId], runChangedTopic(runId), payload);
}

async function publishRunChanged(
  runId: string,
  payload: unknown = null,
): Promise<void> {
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return;
  }

  await publishRunChangedForUser(run.userId, runId, payload);
}

export async function publishRunChangedForUserSafely(
  userId: string,
  runId: string,
  payload: unknown = null,
): Promise<void> {
  await publishRunChangedForUser(userId, runId, payload).catch((error) => {
    log.warn("Failed to publish run changed signal", { runId, error });
  });
}

export async function publishRunChangedSafely(
  runId: string,
  payload: unknown = null,
): Promise<void> {
  await publishRunChanged(runId, payload).catch((error) => {
    log.warn("Failed to publish run changed signal", { runId, error });
  });
}
