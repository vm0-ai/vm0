import { eq, and, or } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { decryptSecretValue } from "../../shared/crypto/secrets-encryption";
import { env } from "../../../env";
import { computeHmacSignature } from "./hmac";
import { logger } from "../../shared/logger";

const log = logger("callback:dispatcher");

interface CallbackRecord {
  id: string;
  url: string;
  encryptedSecret: string;
  payload: unknown;
}

interface DispatchResult {
  callbackId: string;
  success: boolean;
  error?: string;
}

/**
 * Get the API base URL for internal callbacks
 */
export function getApiUrl(): string {
  return env().VM0_API_URL ?? "http://localhost:3000";
}

/**
 * Dispatch all pending callbacks for a completed run
 *
 * This function:
 * 1. Fetches all pending callbacks for the run
 * 2. Sends each callback with HMAC signature
 * 3. Updates callback status based on response
 *
 * Called from the agent complete webhook after run status is updated
 */
export async function dispatchCallbacks(
  runId: string,
  status: "completed" | "failed",
  result?: Record<string, unknown>,
  error?: string,
): Promise<DispatchResult[]> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // Fetch only pending callbacks for this run (prevents double dispatch on retries)
  const callbacks = await globalThis.services.db
    .select({
      id: agentRunCallbacks.id,
      url: agentRunCallbacks.url,
      encryptedSecret: agentRunCallbacks.encryptedSecret,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        or(
          eq(agentRunCallbacks.status, "pending"),
          eq(agentRunCallbacks.status, "failed"),
        ),
      ),
    );

  if (callbacks.length === 0) {
    return [];
  }

  log.debug(`Dispatching ${callbacks.length} callbacks for run ${runId}`);

  const results: DispatchResult[] = [];

  for (const callback of callbacks) {
    const dispatchResult = await dispatchSingleCallback(
      callback,
      runId,
      status,
      result,
      error,
      SECRETS_ENCRYPTION_KEY,
    );
    results.push(dispatchResult);
  }

  return results;
}

/**
 * In local dev, rewrite self-referencing tunnel URLs to localhost to avoid
 * hairpin (server fetching its own tunnel URL times out via cloudflare).
 */
function resolveCallbackUrl(url: string): string {
  const { NODE_ENV } = env();
  return NODE_ENV === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

async function dispatchSingleCallback(
  callback: CallbackRecord,
  runId: string,
  status: "completed" | "failed",
  result: Record<string, unknown> | undefined,
  error: string | undefined,
  encryptionKey: string,
): Promise<DispatchResult> {
  const { id, encryptedSecret, payload } = callback;

  const url = resolveCallbackUrl(callback.url);

  // Decrypt the callback secret
  const secret = decryptSecretValue(encryptedSecret, encryptionKey);

  // Build callback body (callbackId enables PK-based secret lookup on receivers)
  const body = JSON.stringify({
    callbackId: id,
    runId,
    status,
    result,
    error,
    payload,
  });

  // Generate timestamp and signature
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeHmacSignature(body, secret, timestamp);

  // Update attempt count
  await globalThis.services.db
    .update(agentRunCallbacks)
    .set({
      attempts: 1,
      lastAttemptAt: new Date(),
    })
    .where(eq(agentRunCallbacks.id, id));

  // When the callback URL points back at this deployment (e.g. the
  // default VM0_API_URL on a Vercel preview), the lambda's outbound
  // fetch to its own domain hits Vercel's deployment-protection page
  // unless we include the bypass header. Production leaves
  // VERCEL_AUTOMATION_BYPASS_SECRET unset, so the header is omitted and
  // behavior is unchanged.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-VM0-Signature": signature,
    "X-VM0-Timestamp": timestamp.toString(),
  };
  const bypass = env().VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });

    if (response.ok) {
      // Mark as delivered
      await globalThis.services.db
        .update(agentRunCallbacks)
        .set({
          status: "delivered",
          deliveredAt: new Date(),
        })
        .where(eq(agentRunCallbacks.id, id));

      log.debug(`Callback ${id} delivered successfully`);
      return { callbackId: id, success: true };
    } else {
      const errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      await globalThis.services.db
        .update(agentRunCallbacks)
        .set({
          status: "failed",
          lastError: errorMessage,
        })
        .where(eq(agentRunCallbacks.id, id));

      log.warn(`Callback ${id} failed: ${errorMessage}`);
      return { callbackId: id, success: false, error: errorMessage };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    await globalThis.services.db
      .update(agentRunCallbacks)
      .set({
        status: "failed",
        lastError: errorMessage,
      })
      .where(eq(agentRunCallbacks.id, id));

    log.error(`Callback ${id} failed with exception`, { error: err });
    return { callbackId: id, success: false, error: errorMessage };
  }
}

/**
 * Send lightweight progress notifications to all pending callbacks for a run.
 *
 * Used by the heartbeat webhook to keep integration status indicators alive
 * (e.g. Slack's assistant typing indicator which auto-expires after 2 minutes).
 *
 * Unlike dispatchCallbacks, this does NOT update callback status or attempt count.
 * Failures are silently ignored — a missed progress notification is non-critical.
 */
export async function dispatchProgressCallbacks(runId: string): Promise<void> {
  // Skip if run is already completed/failed to avoid race with completion
  // callbacks that clear status indicators (e.g. Slack spinner).
  // The complete webhook updates agentRuns.status synchronously before its
  // after() callback dispatches completion, so this check is effective.
  const [run] = await globalThis.services.db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run || run.status === "completed" || run.status === "failed") {
    return;
  }

  const { SECRETS_ENCRYPTION_KEY } = env();

  const callbacks = await globalThis.services.db
    .select({
      id: agentRunCallbacks.id,
      url: agentRunCallbacks.url,
      encryptedSecret: agentRunCallbacks.encryptedSecret,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.status, "pending"),
      ),
    );

  if (callbacks.length === 0) {
    return;
  }

  await Promise.allSettled(
    callbacks.map((callback) => {
      const url = resolveCallbackUrl(callback.url);
      const secret = decryptSecretValue(
        callback.encryptedSecret,
        SECRETS_ENCRYPTION_KEY,
      );

      const body = JSON.stringify({
        callbackId: callback.id,
        runId,
        status: "progress",
        payload: callback.payload,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const signature = computeHmacSignature(body, secret, timestamp);

      return fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Signature": signature,
          "X-VM0-Timestamp": timestamp.toString(),
        },
        body,
      });
    }),
  );
}
