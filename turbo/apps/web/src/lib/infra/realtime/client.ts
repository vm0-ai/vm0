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
