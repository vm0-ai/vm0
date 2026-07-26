import { command } from "ccstate";
import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";

import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { handleAgentPhoneInternalCallback$ } from "./internal-agentphone-run-callback.service";
import { handleChatInternalCallback$ } from "./internal-chat-run-callback.service";
import { internalRunCallbackKindForRecord } from "./internal-run-callback";
import { handleTeamsOrgInternalCallback$ } from "./internal-teams-org-run-callback.service";
import { handleTelegramInternalCallback$ } from "./internal-telegram-run-callback.service";

function resolveCallbackUrl(url: string): string {
  return env("ENV") === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

export const dispatchProgressCallbacks$ = command(
  async ({ get, set }, runId: string, signal: AbortSignal): Promise<void> => {
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
        internalKind: agentRunCallbacks.internalKind,
        encryptedSecret: agentRunCallbacks.encryptedSecret,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
          or(
            isNull(agentRunCallbacks.internalKind),
            notInArray(agentRunCallbacks.internalKind, [
              "slack:chat",
              "feishu:chat",
              "slack:org",
            ]),
          ),
        ),
      );
    signal.throwIfAborted();

    if (callbacks.length === 0) {
      return;
    }

    await Promise.allSettled(
      callbacks.map(async (callback) => {
        const internalKind = internalRunCallbackKindForRecord(callback);
        const progressCallback = {
          callbackId: callback.id,
          runId,
          status: "progress" as const,
          payload: callback.payload,
        };
        if (internalKind === "chat") {
          await set(
            handleChatInternalCallback$,
            { callback: progressCallback },
            signal,
          );
          return;
        }
        if (internalKind === "slack:chat" || internalKind === "feishu:chat") {
          return;
        }
        if (internalKind === "agentphone") {
          await set(
            handleAgentPhoneInternalCallback$,
            progressCallback,
            signal,
          );
          return;
        }
        if (internalKind === "teams:org") {
          await set(handleTeamsOrgInternalCallback$, progressCallback, signal);
          return;
        }
        if (internalKind === "telegram") {
          await set(handleTelegramInternalCallback$, progressCallback, signal);
          return;
        }
        if (internalKind === "agent" || internalKind === "github:issues") {
          return;
        }
        if (!callback.url) {
          return;
        }
        if (!callback.encryptedSecret) {
          return;
        }
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
