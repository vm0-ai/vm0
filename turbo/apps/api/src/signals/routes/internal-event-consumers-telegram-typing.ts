import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { internalEventConsumerTelegramTypingContract } from "@vm0/api-contracts/contracts/internal-event-consumers";

import {
  eventConsumerPayload$,
  eventConsumerRoute,
} from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import { sendChatAction } from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { decryptSecretValue } from "../services/crypto.utils";
import type { RouteEntry } from "../route";
import { tapError } from "../utils";

const L = logger("event-consumer:telegram-typing");

interface TelegramTypingTarget {
  readonly installationId: string;
  readonly chatId: string;
}

function parseTelegramTypingTarget(
  payload: unknown,
): TelegramTypingTarget | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const data = payload as Record<string, unknown>;
  if (
    typeof data.installationId !== "string" ||
    typeof data.chatId !== "string"
  ) {
    return undefined;
  }
  return { installationId: data.installationId, chatId: data.chatId };
}

// Background-task command. Receives a fresh signal from the caller; failures
// here are caught by tapError at the call site so they cannot crash
// the already-returned 200 response.
const refreshTelegramTypingForRun$ = command(
  async ({ get }, runId: string, _signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const callbacks = await db
      .select({
        url: agentRunCallbacks.url,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
        ),
      );

    const targets = new Map<string, TelegramTypingTarget>();
    for (const callback of callbacks) {
      if (!callback.url.endsWith("/api/internal/callbacks/telegram")) {
        continue;
      }
      const target = parseTelegramTypingTarget(callback.payload);
      if (target) {
        targets.set(`${target.installationId}:${target.chatId}`, target);
      }
    }

    for (const target of targets.values()) {
      if (isOfficialTelegramBotId(target.installationId)) {
        const config = getOfficialTelegramBotConfig();
        if (!config.botToken) {
          continue;
        }
        await sendChatAction(config.botToken, target.chatId, "typing");
        continue;
      }

      const [installation] = await db
        .select({
          encryptedBotToken: telegramInstallations.encryptedBotToken,
        })
        .from(telegramInstallations)
        .where(eq(telegramInstallations.telegramBotId, target.installationId))
        .limit(1);

      if (!installation) {
        continue;
      }

      const botToken = decryptSecretValue(installation.encryptedBotToken);
      await sendChatAction(botToken, target.chatId, "typing");
    }
  },
);

const refreshInner$ = command(
  ({ get, set }, signal: AbortSignal): RefreshResponse => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();

    waitUntil(
      tapError(
        set(refreshTelegramTypingForRun$, payload.runId, signal),
        (error) => {
          L.debug("Failed to refresh Telegram typing from events", {
            runId: payload.runId,
            error,
          });
        },
      ),
    );

    return { status: 200, body: { scheduled: true } };
  },
);

interface RefreshResponse {
  readonly status: 200;
  readonly body: { readonly scheduled: true };
}

export const internalEventConsumerTelegramTypingRoutes: readonly RouteEntry[] =
  [
    {
      route: internalEventConsumerTelegramTypingContract.refresh,
      handler: eventConsumerRoute(refreshInner$),
    },
  ];
