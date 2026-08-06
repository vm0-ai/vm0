import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { SharedThreadMessages } from "@vm0/db/jsonb-contracts/shared-thread";

import { chatThreads } from "./chat-thread";

/** Immutable public snapshots created from an explicit chat-event selection. */
export const sharedThreads = pgTable(
  "shared_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sourceChatThreadId: uuid("source_chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    messages: jsonb("messages").$type<SharedThreadMessages>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("shared_threads_user_created_idx").on(
        table.userId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
      index("shared_threads_source_created_idx").on(
        table.sourceChatThreadId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    ];
  },
);
