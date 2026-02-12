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
 * Get channel name for a run
 */
function getRunChannelName(runId: string): string {
  return `run:${runId}`;
}

/**
 * Publish events to the run's Ably channel.
 * Non-blocking - logs errors but doesn't throw.
 */
export async function publishEvents(
  runId: string,
  events: unknown[],
  nextSequence: number,
): Promise<boolean> {
  const client = getAblyClient();
  if (!client) {
    log.debug("Ably not configured, skipping publish");
    return false;
  }

  try {
    const channel = client.channels.get(getRunChannelName(runId));
    await channel.publish("events", { events, nextSequence });
    log.debug(`Published ${events.length} events to run:${runId}`);
    return true;
  } catch (error) {
    log.error(`Ably publish failed for run:${runId}:`, error);
    return false;
  }
}

/**
 * Publish run status update to the run's Ably channel.
 * Non-blocking - logs errors but doesn't throw.
 */
export async function publishStatus(
  runId: string,
  status: "completed" | "failed" | "timeout",
  result?: Record<string, unknown>,
  error?: string,
): Promise<boolean> {
  const client = getAblyClient();
  if (!client) {
    log.debug("Ably not configured, skipping status publish");
    return false;
  }

  try {
    const channel = client.channels.get(getRunChannelName(runId));
    await channel.publish("status", { status, result, error });
    log.debug(`Published status ${status} to run:${runId}`);
    return true;
  } catch (error) {
    log.error(`Ably status publish failed for run:${runId}:`, error);
    return false;
  }
}

/**
 * Generate an Ably token for a specific run channel (subscribe only).
 * Used by CLI to authenticate and subscribe to run events.
 */
export async function generateRunToken(
  runId: string,
): Promise<Ably.TokenRequest | null> {
  const client = getAblyClient();
  if (!client) {
    log.debug("Ably not configured, cannot generate token");
    return null;
  }

  try {
    const channelName = getRunChannelName(runId);
    const tokenRequest = await client.auth.createTokenRequest({
      capability: {
        [channelName]: ["subscribe"],
      },
      ttl: 3600000, // 1 hour
    });
    log.debug(`Generated token for run:${runId}`);
    return tokenRequest;
  } catch (error) {
    log.error(`Ably token generation failed for run:${runId}:`, error);
    return null;
  }
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
