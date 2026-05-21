import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { whatsappUserLinks } from "./whatsapp-user-link";

export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    webhookId: varchar("webhook_id", { length: 255 }),
    twilioMessageSid: varchar("twilio_message_sid", {
      length: 255,
    }).notNull(),
    whatsappUserLinkId: uuid("whatsapp_user_link_id").references(
      () => {
        return whatsappUserLinks.id;
      },
      { onDelete: "set null" },
    ),
    phoneHandle: varchar("phone_handle", { length: 32 }).notNull(),
    fromNumber: varchar("from_number", { length: 32 }).notNull(),
    toNumber: varchar("to_number", { length: 32 }).notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    body: text("body"),
    mediaUrls: jsonb("media_urls")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    isBot: boolean("is_bot").default(false).notNull(),
    receivedAt: timestamp("received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_whatsapp_messages_twilio_message").on(
        table.twilioMessageSid,
      ),
      uniqueIndex("idx_whatsapp_messages_webhook_id")
        .on(table.webhookId)
        .where(sql`webhook_id IS NOT NULL`),
      index("idx_whatsapp_messages_handle_created").on(
        table.phoneHandle,
        table.createdAt,
      ),
      index("idx_whatsapp_messages_user_link").on(table.whatsappUserLinkId),
    ];
  },
);
