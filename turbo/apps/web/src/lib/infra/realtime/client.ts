import "server-only";
import Ably from "ably";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

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

  const channelName = getRunnerGroupChannelName(group);
  const tokenRequest = await client.auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 3600000, // 1 hour
  });
  log.debug(`Generated token for runner-group:${group}`);
  return tokenRequest;
}

/**
 * Publish job notification to a runner group's Ably channel.
 * Sends runId + profile so runner can pre-check resource budget before claiming.
 * Non-blocking - logs errors but doesn't throw.
 */
export async function publishJobNotification(
  group: string,
  runId: string,
  profile: string,
  targetRunnerId: string | null = null,
): Promise<boolean> {
  const client = getAblyClient();
  if (!client) {
    log.debug("Ably not configured, skipping job notification");
    return false;
  }

  try {
    const channel = client.channels.get(getRunnerGroupChannelName(group));
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
 * Non-blocking - logs errors but doesn't throw.
 */
export async function publishCancelNotification(
  group: string,
  runId: string,
): Promise<boolean> {
  const client = getAblyClient();
  if (!client) {
    log.debug("Ably not configured, skipping cancel notification");
    return false;
  }

  try {
    const channel = client.channels.get(getRunnerGroupChannelName(group));
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
