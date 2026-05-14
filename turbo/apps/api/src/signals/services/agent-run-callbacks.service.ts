import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";

import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import { decryptSecretValue } from "./crypto.utils";

function resolveCallbackUrl(url: string): string {
  return env("ENV") === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

export const dispatchProgressCallbacks$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();

    if (!run || run.status === "completed" || run.status === "failed") {
      return;
    }

    const callbacks = await db
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
    signal.throwIfAborted();

    if (callbacks.length === 0) {
      return;
    }

    await Promise.allSettled(
      callbacks.map((callback) => {
        const body = JSON.stringify({
          callbackId: callback.id,
          runId,
          status: "progress",
          payload: callback.payload,
        });
        const timestamp = Math.floor(now() / 1000);
        const signature = computeHmacSignature(
          body,
          decryptSecretValue(callback.encryptedSecret),
          timestamp,
        );

        return fetch(resolveCallbackUrl(callback.url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VM0-Signature": signature,
            "X-VM0-Timestamp": timestamp.toString(),
          },
          body,
          signal,
        });
      }),
    );
  },
);
