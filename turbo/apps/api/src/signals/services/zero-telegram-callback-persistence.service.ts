import { and, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
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

function telegramThreadSessionOwnerWhere(args: {
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
}) {
  return args.userLinkKind === "custom"
    ? eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId)
    : eq(telegramThreadSessions.telegramOfficialUserLinkId, args.userLinkId);
}

function telegramThreadSessionOwnerValues(args: {
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
}): {
  readonly telegramUserLinkId: string | null;
  readonly telegramOfficialUserLinkId: string | null;
} {
  return args.userLinkKind === "custom"
    ? {
        telegramUserLinkId: args.userLinkId,
        telegramOfficialUserLinkId: null,
      }
    : {
        telegramUserLinkId: null,
        telegramOfficialUserLinkId: args.userLinkId,
      };
}

function telegramMessageIdIsNewer(messageId: string) {
  return or(
    isNull(telegramThreadSessions.lastProcessedMessageId),
    lt(
      sql`${telegramThreadSessions.lastProcessedMessageId}::bigint`,
      sql`${messageId}::bigint`,
    ),
  );
}

async function upsertCanonicalTelegramThreadSession(args: {
  readonly db: Db;
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly agentSessionId: string;
  readonly messageId: string;
  readonly updateLastProcessed: boolean;
}): Promise<void> {
  const [updated] = await args.db
    .update(telegramThreadSessions)
    .set({
      agentSessionId: args.agentSessionId,
      updatedAt: nowDate(),
    })
    .where(
      and(
        telegramThreadSessionOwnerWhere(args),
        eq(telegramThreadSessions.chatId, args.chatId),
        eq(telegramThreadSessions.rootMessageId, args.rootMessageId),
      ),
    )
    .returning({ id: telegramThreadSessions.id });
  if (updated) {
    if (args.updateLastProcessed) {
      await args.db
        .update(telegramThreadSessions)
        .set({
          lastProcessedMessageId: args.messageId,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(telegramThreadSessions.id, updated.id),
            telegramMessageIdIsNewer(args.messageId),
          ),
        );
    }
    return;
  }

  await args.db
    .insert(telegramThreadSessions)
    .values({
      ...telegramThreadSessionOwnerValues(args),
      chatId: args.chatId,
      rootMessageId: args.rootMessageId,
      agentSessionId: args.agentSessionId,
      lastProcessedMessageId: args.messageId,
    })
    .onConflictDoNothing();
}

/**
 * Dual-write the canonical Telegram reply chain into the legacy session table
 * so rollback-eligible API versions continue from the canonical session.
 */
export async function saveCanonicalTelegramThreadSession(args: {
  readonly db: Db;
  readonly userLinkId: string;
  readonly userLinkKind: "custom" | "official";
  readonly chatId: string;
  readonly previousRootMessageId: string | null;
  readonly botReplyMessageId: string;
  readonly agentSessionId: string;
  readonly messageId: string;
  readonly runStatus: "completed" | "failed";
  readonly isDM: boolean;
}): Promise<void> {
  if (args.isDM) {
    const [existing] = await args.db
      .select({ agentSessionId: telegramThreadSessions.agentSessionId })
      .from(telegramThreadSessions)
      .where(
        and(
          telegramThreadSessionOwnerWhere(args),
          eq(telegramThreadSessions.chatId, args.chatId),
          eq(telegramThreadSessions.rootMessageId, "dm"),
        ),
      )
      .limit(1);
    await upsertCanonicalTelegramThreadSession({
      ...args,
      rootMessageId: "dm",
      updateLastProcessed:
        args.runStatus === "completed" ||
        existing?.agentSessionId !== args.agentSessionId,
    });
    return;
  }

  if (args.previousRootMessageId === null) {
    await upsertCanonicalTelegramThreadSession({
      ...args,
      rootMessageId: args.botReplyMessageId,
      updateLastProcessed: true,
    });
    return;
  }

  if (args.runStatus !== "completed") {
    return;
  }
  const updated = await args.db
    .update(telegramThreadSessions)
    .set({
      rootMessageId: args.botReplyMessageId,
      agentSessionId: args.agentSessionId,
      lastProcessedMessageId: args.messageId,
      updatedAt: nowDate(),
    })
    .where(
      and(
        telegramThreadSessionOwnerWhere(args),
        eq(telegramThreadSessions.chatId, args.chatId),
        eq(telegramThreadSessions.rootMessageId, args.previousRootMessageId),
        telegramMessageIdIsNewer(args.messageId),
      ),
    )
    .returning({ id: telegramThreadSessions.id });
  if (updated.length > 0) {
    return;
  }

  const [newerSessionRow] = await args.db
    .select({ id: telegramThreadSessions.id })
    .from(telegramThreadSessions)
    .where(
      and(
        telegramThreadSessionOwnerWhere(args),
        eq(telegramThreadSessions.chatId, args.chatId),
        or(
          eq(
            telegramThreadSessions.rootMessageId,
            args.previousRootMessageId,
          ),
          eq(telegramThreadSessions.agentSessionId, args.agentSessionId),
        ),
        isNotNull(telegramThreadSessions.lastProcessedMessageId),
        gte(
          sql`${telegramThreadSessions.lastProcessedMessageId}::bigint`,
          sql`${args.messageId}::bigint`,
        ),
      ),
    )
    .limit(1);
  if (newerSessionRow) {
    return;
  }

  await upsertCanonicalTelegramThreadSession({
    ...args,
    rootMessageId: args.botReplyMessageId,
    updateLastProcessed: true,
  });
}
