import "server-only";
import Ably from "ably";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("realtime");

let ablyClient: Ably.Rest | null = null;

function getAblyClient(): Ably.Rest {
  if (!ablyClient) {
    ablyClient = new Ably.Rest({ key: env().ABLY_API_KEY, queryTime: true });
    log.debug("Ably client initialized");
  }

  return ablyClient;
}

function getRunnerGroupChannelName(group: string): string {
  return `runner-group:${group}`;
}

function getUserChannelName(userId: string): string {
  return `user:${userId}`;
}

/**
 * Publish an invalidation signal to specific users' channels.
 * Used by server-side code to notify frontend clients that data has changed.
 * An optional `payload` can be included for richer signals (e.g. read cursors).
 */
export async function publishUserSignal(
  userIds: string[],
  topic: string,
  payload: unknown = null,
): Promise<void> {
  const client = getAblyClient();
  await Promise.all(
    userIds.map(async (userId) => {
      const channel = client.channels.get(getUserChannelName(userId));
      await channel.publish(topic, payload);
    }),
  );
  log.debug(`Published signal "${topic}" to ${userIds.length} user(s)`);
}

/**
 * Publish job notification to a runner group's Ably channel.
 * Sends runId + profile so runner can pre-check resource budget before claiming.
 * Non-blocking — logs errors but doesn't throw, because the job is already
 * queued in DB and runners will eventually poll it even if Ably is degraded.
 */
export async function publishJobNotification(
  group: string,
  runId: string,
  profile: string,
  targetRunnerId: string | null = null,
): Promise<boolean> {
  try {
    const channel = getAblyClient().channels.get(
      getRunnerGroupChannelName(group),
    );
    await channel.publish("job", {
      runId,
      profile,
      ...(targetRunnerId && { targetRunnerId }),
    });
    log.debug(
      `Published job notification ${runId} to runner-group:${group}` +
        (targetRunnerId ? ` (target: ${targetRunnerId})` : " (broadcast)"),
    );
    return true;
  } catch (error) {
    log.error(`Ably job notification failed for runner-group:${group}:`, error);
    return false;
  }
}

/**
 * Publish cancel notification to a runner group's Ably channel.
 * Non-blocking — logs errors but doesn't throw, because the cancellation is
 * already committed in DB and the VM will stop at natural completion even if
 * Ably is degraded.
 */
export async function publishCancelNotification(
  group: string,
  runId: string,
): Promise<boolean> {
  try {
    const channel = getAblyClient().channels.get(
      getRunnerGroupChannelName(group),
    );
    await channel.publish("cancel", { runId });
    log.debug(
      `Published cancel notification ${runId} to runner-group:${group}`,
    );
    return true;
  } catch (error) {
    log.error(
      `Ably cancel notification failed for runner-group:${group}:`,
      error,
    );
    return false;
  }
}
