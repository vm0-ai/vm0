import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chatEvents } from "./chat-event";

/**
 * Chat event input parameters table.
 * A row exists only while its input event is pending and is deleted when that
 * event is claimed or rejected.
 */
export const chatEventInputParams = pgTable("chat_event_input_params", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(
      () => {
        return chatEvents.id;
      },
      { onDelete: "cascade" },
    ),
  encryptedParams: text("encrypted_params").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
