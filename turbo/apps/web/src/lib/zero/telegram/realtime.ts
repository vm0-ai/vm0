import { publishUserSignal } from "../../infra/realtime/client";
import { logger } from "../../shared/logger";
import { publishOrgSignal } from "../realtime";

const log = logger("telegram:realtime");

const TELEGRAM_CHANGED_TOPIC = "telegram:changed";

async function publishTelegramUserChanged(userId: string): Promise<void> {
  await publishUserSignal([userId], TELEGRAM_CHANGED_TOPIC);
}

export async function publishTelegramUserChangedSafely(
  userId: string,
): Promise<void> {
  await publishTelegramUserChanged(userId).catch((error) => {
    log.warn("Failed to publish Telegram user change signal", {
      userId,
      error,
    });
  });
}

async function publishTelegramOrgChanged(orgId: string): Promise<void> {
  await publishOrgSignal(orgId, TELEGRAM_CHANGED_TOPIC);
}

export async function publishTelegramOrgChangedSafely(
  orgId: string,
): Promise<void> {
  await publishTelegramOrgChanged(orgId).catch((error) => {
    log.warn("Failed to publish Telegram org change signal", { orgId, error });
  });
}
