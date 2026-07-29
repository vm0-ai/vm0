import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramChatThreadRoutes } from "@vm0/db/schema/telegram-chat-thread-route";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";

import { nowDate } from "../external/time";
import type { Db } from "../external/db";

type TelegramMessageScope =
  | { readonly kind: "custom"; readonly installationId: string }
  | {
      readonly kind: "official";
      readonly orgId: string;
      readonly userLinkId: string | null;
    };

export async function storeTelegramBotMessage(args: {
  readonly db: Db;
  readonly scope: TelegramMessageScope;
  readonly chatId: string;
  readonly messageId: number;
  readonly text: string | undefined;
}): Promise<void> {
  await args.db
    .insert(telegramMessages)
    .values({
      installationId:
        args.scope.kind === "custom" ? args.scope.installationId : null,
      officialOrgId: args.scope.kind === "official" ? args.scope.orgId : null,
      officialUserLinkId:
        args.scope.kind === "official" ? args.scope.userLinkId : null,
      chatId: args.chatId,
      messageId: String(args.messageId),
      fromUserId: "0",
      fromUsername: null,
      fromDisplayName: null,
      text: args.text ?? null,
      fileId: null,
      fileType: null,
      fileName: null,
      fileMimeType: null,
      fileSize: null,
      fileWidth: null,
      fileHeight: null,
      fileDuration: null,
      entities: null,
      isBot: true,
    })
    .onConflictDoNothing();
}

export async function saveTelegramThreadSession(args: {
  readonly db: Db;
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly previousRootMessageId: string | undefined;
  readonly existingSessionId: string | undefined;
  readonly newSessionId: string | undefined;
  readonly messageId: string;
  readonly runStatus: "completed" | "failed";
}): Promise<void> {
  if (!args.existingSessionId && args.newSessionId) {
    const updated = await args.db
      .update(telegramThreadSessions)
      .set({
        agentSessionId: args.newSessionId,
        lastProcessedMessageId: args.messageId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          args.userLinkKind === "custom"
            ? eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId)
            : eq(
                telegramThreadSessions.telegramOfficialUserLinkId,
                args.userLinkId,
              ),
          eq(telegramThreadSessions.chatId, args.chatId),
          eq(telegramThreadSessions.rootMessageId, args.rootMessageId),
        ),
      )
      .returning({ id: telegramThreadSessions.id });

    if (updated.length > 0) {
      return;
    }

    await args.db
      .insert(telegramThreadSessions)
      .values({
        telegramUserLinkId:
          args.userLinkKind === "custom" ? args.userLinkId : null,
        telegramOfficialUserLinkId:
          args.userLinkKind === "official" ? args.userLinkId : null,
        chatId: args.chatId,
        rootMessageId: args.rootMessageId,
        agentSessionId: args.newSessionId,
        lastProcessedMessageId: args.messageId,
      })
      .onConflictDoNothing();
    return;
  }

  if (args.existingSessionId && args.runStatus === "completed") {
    const matchRootMessageId = args.previousRootMessageId ?? args.rootMessageId;
    await args.db
      .update(telegramThreadSessions)
      .set({
        rootMessageId: args.rootMessageId,
        lastProcessedMessageId: args.messageId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          args.userLinkKind === "custom"
            ? eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId)
            : eq(
                telegramThreadSessions.telegramOfficialUserLinkId,
                args.userLinkId,
              ),
          eq(telegramThreadSessions.chatId, args.chatId),
          eq(telegramThreadSessions.rootMessageId, matchRootMessageId),
        ),
      );
  }
}

export async function saveCanonicalTelegramThreadCompatibility(args: {
  readonly db: Db;
  readonly routeId: string;
  readonly chatThreadId: string;
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly previousRootMessageId: string | undefined;
  readonly routeCreated: boolean;
  readonly seededFromLegacy: boolean;
  readonly sessionId: string;
  readonly messageId: string;
  readonly runStatus: "completed" | "failed";
}): Promise<void> {
  const isInitialReply =
    args.previousRootMessageId === undefined ||
    (args.routeCreated && !args.seededFromLegacy);
  const shouldAdvanceRoot = isInitialReply || args.runStatus === "completed";
  const currentTime = nowDate();
  await args.db.transaction(async (tx) => {
    let advancedCanonicalRoute = false;
    if (shouldAdvanceRoot) {
      const updated = await tx
        .update(telegramChatThreadRoutes)
        .set({
          rootMessageId: args.rootMessageId,
          lastProcessedMessageId: args.messageId,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(telegramChatThreadRoutes.id, args.routeId),
            eq(telegramChatThreadRoutes.chatThreadId, args.chatThreadId),
            or(
              isNull(telegramChatThreadRoutes.lastProcessedMessageId),
              lt(
                sql`${telegramChatThreadRoutes.lastProcessedMessageId}::bigint`,
                sql`${args.messageId}::bigint`,
              ),
            ),
          ),
        )
        .returning({ id: telegramChatThreadRoutes.id });
      advancedCanonicalRoute = updated.length > 0;
    }

    if (!advancedCanonicalRoute) {
      return;
    }
    const legacyRootMessageId =
      args.previousRootMessageId ?? args.rootMessageId;
    const updated = await tx
      .update(telegramThreadSessions)
      .set({
        rootMessageId: args.rootMessageId,
        agentSessionId: args.sessionId,
        lastProcessedMessageId: args.messageId,
        updatedAt: currentTime,
      })
      .where(
        and(
          args.userLinkKind === "custom"
            ? eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId)
            : eq(
                telegramThreadSessions.telegramOfficialUserLinkId,
                args.userLinkId,
              ),
          eq(telegramThreadSessions.chatId, args.chatId),
          eq(telegramThreadSessions.rootMessageId, legacyRootMessageId),
          or(
            isNull(telegramThreadSessions.lastProcessedMessageId),
            lt(
              sql`${telegramThreadSessions.lastProcessedMessageId}::bigint`,
              sql`${args.messageId}::bigint`,
            ),
          ),
        ),
      )
      .returning({ id: telegramThreadSessions.id });
    if (updated.length > 0) {
      return;
    }
    await tx
      .insert(telegramThreadSessions)
      .values({
        telegramUserLinkId:
          args.userLinkKind === "custom" ? args.userLinkId : null,
        telegramOfficialUserLinkId:
          args.userLinkKind === "official" ? args.userLinkId : null,
        chatId: args.chatId,
        rootMessageId: args.rootMessageId,
        agentSessionId: args.sessionId,
        lastProcessedMessageId: args.messageId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .onConflictDoNothing();
  });
}
