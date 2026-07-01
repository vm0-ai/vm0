import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

export const htmlArtifactEditDrafts = pgTable(
  "html_artifact_edit_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    artifactUrl: text("artifact_url").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_html_artifact_edit_drafts_thread_artifact").on(
        table.chatThreadId,
        table.artifactUrl,
      ),
      index("idx_html_artifact_edit_drafts_thread").on(table.chatThreadId),
    ];
  },
);
