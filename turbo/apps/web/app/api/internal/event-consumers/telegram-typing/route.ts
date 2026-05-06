import { after, NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyEventConsumer } from "../../../../../src/lib/infra/event-consumer";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import {
  createTelegramClient,
  sendChatAction,
} from "../../../../../src/lib/zero/telegram/client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../../../../../src/lib/zero/telegram/official";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("event-consumer:telegram-typing");

interface TelegramTypingTarget {
  installationId: string;
  chatId: string;
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
  return {
    installationId: data.installationId,
    chatId: data.chatId,
  };
}

async function refreshTelegramTypingForRun(runId: string): Promise<number> {
  const callbacks = await globalThis.services.db
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

  if (targets.size === 0) {
    return 0;
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  let refreshed = 0;

  for (const target of targets.values()) {
    if (isOfficialTelegramBotId(target.installationId)) {
      const botToken = getOfficialTelegramBotConfig().botToken;
      if (!botToken) {
        continue;
      }
      const client = createTelegramClient(botToken);
      await sendChatAction(client, target.chatId, "typing");
      refreshed++;
      continue;
    }

    const [installation] = await globalThis.services.db
      .select({
        encryptedBotToken: telegramInstallations.encryptedBotToken,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, target.installationId))
      .limit(1);

    if (!installation) {
      continue;
    }

    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createTelegramClient(botToken);
    await sendChatAction(client, target.chatId, "typing");
    refreshed++;
  }

  return refreshed;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyEventConsumer(request);
  if (!result.ok) {
    return result.response;
  }

  const { runId, events } = result.data;

  after(() => {
    return refreshTelegramTypingForRun(runId).catch((error) => {
      log.debug("Failed to refresh Telegram typing from events", {
        runId,
        batch: events.length,
        error,
      });
    });
  });

  return NextResponse.json({ scheduled: true });
}
