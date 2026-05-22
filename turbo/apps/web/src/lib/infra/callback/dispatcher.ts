import { eq, and } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { decryptPersistentSecretValue } from "../../shared/crypto/kms-secrets-encryption";
import { env } from "../../../env";
import { computeHmacSignature } from "./hmac";

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

/**
 * Send lightweight progress notifications to all pending callbacks for a run.
 *
 * Used by the heartbeat webhook to keep integration status indicators alive
 * (e.g. Slack's assistant typing indicator which auto-expires after 2 minutes).
 *
 * This does not update callback status or attempt count.
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
    callbacks.map(async (callback) => {
      const url = resolveCallbackUrl(callback.url);
      const secret = await decryptPersistentSecretValue(
        callback.encryptedSecret,
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
