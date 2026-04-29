import { initServices } from "../init-services";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";

/**
 * Record a call to the Telegram Bot API mock so BATS e2e tests can assert on
 * callback side effects after serverless functions complete.
 */
export async function logTelegramMockCall(
  method: string,
  botToken: string,
  request: Request,
): Promise<void> {
  try {
    const rawBody = await request.clone().text();
    let bodyJson: Record<string, unknown> | null = null;
    let chatId: string | null = null;

    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        bodyJson = parsed;
        const bodyChatId = parsed.chat_id;
        if (typeof bodyChatId === "string" || typeof bodyChatId === "number") {
          chatId = String(bodyChatId);
        }
      } catch {
        bodyJson = null;
      }
    }

    initServices();
    await globalThis.services.db.insert(e2eTelegramMockCallLog).values({
      method,
      botToken,
      chatId,
      body: rawBody,
      bodyJson,
    });
  } catch {
    // Diagnostic logging must not break the mock response.
  }
}
