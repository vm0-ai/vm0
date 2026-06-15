import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";

import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchOverrides } from "./feature-switches.service";

function resolveCallbackUrl(url: string): string {
  return env("ENV") === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

export const dispatchProgressCallbacks$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const [run] = await db
      .select({
        status: agentRuns.status,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();

    if (!run || run.status === "completed" || run.status === "failed") {
      return;
    }
    const featureSwitchContext = {
      orgId: run.orgId,
      userId: run.userId,
      overrides: await get(userFeatureSwitchOverrides(run.orgId, run.userId)),
    } satisfies FeatureSwitchContext;

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
      callbacks.map(async (callback) => {
        const body = JSON.stringify({
          callbackId: callback.id,
          runId,
          status: "progress",
          payload: callback.payload,
        });
        const timestamp = Math.floor(now() / 1000);
        const signature = computeHmacSignature(
          body,
          await decryptPersistentSecretValue(
            callback.encryptedSecret,
            featureSwitchContext,
          ),
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
