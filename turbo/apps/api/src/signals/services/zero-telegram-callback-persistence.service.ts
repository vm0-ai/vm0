import { telegramMessages } from "@vm0/db/schema/telegram-message";

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
