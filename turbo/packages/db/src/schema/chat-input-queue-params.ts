import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ChatEventAttachFileMetadataList } from "@vm0/db/jsonb-contracts/chat-event";
import { chatEvents } from "./chat-event";

/**
 * Chat input queue parameters table.
 * Temporary storage for server-only transport state while an input event is
 * pending. Records are deleted after claim or rejection.
 */
export const chatInputQueueParams = pgTable("chat_input_queue_params", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(
      () => {
        return chatEvents.id;
      },
      { onDelete: "cascade" },
    ),
  encryptedParams: text("encrypted_params").notNull(),
  attachFileMetadata: jsonb(
    "attach_file_metadata",
  ).$type<ChatEventAttachFileMetadataList>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
