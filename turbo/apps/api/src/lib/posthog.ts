import { PostHog } from "posthog-node";

import { logger } from "./log";

const L = logger("PostHog");

const POSTHOG_KEY = process.env.POSTHOG_PROJECT_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

let cachedClient: PostHog | null = null;

function getClient(): PostHog | null {
  if (!POSTHOG_KEY) {
    return null;
  }
  if (!cachedClient) {
    // flushAt/flushInterval force immediate delivery: the API runs in a
    // serverless context that can freeze between requests, so buffered events
    // would otherwise be lost.
    cachedClient = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return cachedClient;
}

/**
 * Fire-and-forget server-side PostHog capture. Never throws (analytics must
 * never break a request flow) and is a no-op when POSTHOG_PROJECT_API_KEY is
 * unset, so it is safe to call from anywhere on the server.
 */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const client = getClient();
  if (!client) {
    return;
  }
  try {
    client.capture({ distinctId, event, properties });
    await client.flush();
  } catch (error) {
    L.warn("PostHog server capture failed", { event, error });
  }
}
