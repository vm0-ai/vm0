import "server-only";
import Ably from "ably";
import { env } from "../../env";
import { logger } from "../logger";

const log = logger("realtime");

let ablyClient: Ably.Rest | null = null;

/**
 * Get the Ably REST client singleton.
 * Returns null if ABLY_API_KEY is not configured.
 */
function getAblyClient(): Ably.Rest | null {
  const apiKey = env().ABLY_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (!ablyClient) {
    ablyClient = new Ably.Rest({ key: apiKey });
    log.debug("Ably client initialized");
  }

  return ablyClient;
}

/**
 * Get channel name for a runner group
 */
function getRunnerGroupChannelName(group: string): string {
  return `runner-group:${group}`;
}

/**
 * Generate an Ably token for a specific runner group channel (subscribe only).
 * Used by runners to authenticate and subscribe to job notifications.
 */
export async function generateRunnerGroupToken(
  group: string,
): Promise<Ably.TokenRequest | null> {
  const client = getAblyClient();
  if (!client) {
    log.debug("Ably not configured, cannot generate token");
    return null;
  }

  try {
    const channelName = getRunnerGroupChannelName(group);
    const tokenRequest = await client.auth.createTokenRequest({
      capability: {
        [channelName]: ["subscribe"],
      },
      ttl: 3600000, // 1 hour
    });
    log.debug(`Generated token for runner-group:${group}`);
    return tokenRequest;
  } catch (error) {
    log.error(`Ably token generation failed for runner-group:${group}:`, error);
    return null;
  }
}

/**
 * Publish job notification to a runner group's Ably channel.
 * Only sends runId - runner will claim job to get full context.
 * Non-blocking - logs errors but doesn't throw.
 */
export async function publishJobNotification(
  group: string,
  runId: string,
): Promise<boolean> {
  const client = getAblyClient();
  if (!client) {
    log.debug("Ably not configured, skipping job notification");
    return false;
  }

  try {
    const channel = client.channels.get(getRunnerGroupChannelName(group));
    await channel.publish("job", { runId });
    log.debug(`Published job notification ${runId} to runner-group:${group}`);
    return true;
  } catch (error) {
    log.error(`Ably job notification failed for runner-group:${group}:`, error);
    return false;
  }
}
