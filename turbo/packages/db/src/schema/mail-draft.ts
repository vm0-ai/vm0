import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ZeroMailDraftStatus } from "@vm0/api-contracts/contracts/zero-mail";
import { chatThreads } from "./chat-thread";
import { connectors } from "./connector";

export const mailDrafts = pgTable(
  "mail_drafts",
  {
    id: uuid("id").primaryKey(),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "cascade" },
    ),
    connectorId: uuid("connector_id").references(
      () => {
        return connectors.id;
      },
      { onDelete: "set null" },
    ),
    gmailDraftId: text("gmail_draft_id"),
    gmailThreadId: text("gmail_thread_id"),
    gmailMessageId: text("gmail_message_id"),
    sentGmailMessageId: text("sent_gmail_message_id"),
    status: text("status").$type<ZeroMailDraftStatus>(),
    senderName: text("sender_name"),
    senderAddress: text("sender_address"),
    subject: text("subject"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    sentAt: timestamp("sent_at"),
  },
  (table) => {
    return [
      index("idx_mail_drafts_chat_thread").on(table.chatThreadId),
      uniqueIndex("mail_drafts_connector_gmail_draft_unique").on(
        table.connectorId,
        table.gmailDraftId,
      ),
    ];
  },
);
