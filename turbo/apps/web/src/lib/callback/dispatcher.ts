import { eq } from "drizzle-orm";
import { agentRunCallbacks } from "../../db/schema/agent-run-callback";
import { decryptCredentialValue } from "../crypto/secrets-encryption";
import { env } from "../../env";
import { computeHmacSignature } from "./hmac";
import { logger } from "../logger";

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
 * Priority: VM0_API_URL > VERCEL_URL > localhost fallback
 */
export function getApiUrl(): string {
  const { VM0_API_URL, VERCEL_URL } = env();
  if (VM0_API_URL) {
    return VM0_API_URL;
  }
  if (VERCEL_URL) {
    return `https://${VERCEL_URL}`;
  }
  return "http://localhost:3000";
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

  // Fetch all pending callbacks for this run
  const callbacks = await globalThis.services.db
    .select({
      id: agentRunCallbacks.id,
      url: agentRunCallbacks.url,
      encryptedSecret: agentRunCallbacks.encryptedSecret,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));

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

async function dispatchSingleCallback(
  callback: CallbackRecord,
  runId: string,
  status: "completed" | "failed",
  result: Record<string, unknown> | undefined,
  error: string | undefined,
  encryptionKey: string,
): Promise<DispatchResult> {
  const { id, url, encryptedSecret, payload } = callback;

  // Decrypt the callback secret
  const secret = decryptCredentialValue(encryptedSecret, encryptionKey);

  // Build callback body
  const body = JSON.stringify({
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

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VM0-Signature": signature,
        "X-VM0-Timestamp": timestamp.toString(),
      },
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
