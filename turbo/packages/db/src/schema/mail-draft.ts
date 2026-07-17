import { jsonb, pgTable, uuid } from "drizzle-orm/pg-core";
import type { MailDraftData } from "@vm0/db/jsonb-contracts/mail-draft";
import { chatMessages } from "./chat-message";

export const mailDrafts = pgTable("mail_drafts", {
  id: uuid("id")
    .primaryKey()
    .references(
      () => {
        return chatMessages.mailDraftId;
      },
      { onDelete: "cascade" },
    ),
  draft: jsonb("draft").$type<MailDraftData>().notNull(),
});
