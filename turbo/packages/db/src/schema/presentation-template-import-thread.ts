import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";
import { presentationTemplates } from "./presentation-template";

/**
 * The chat thread an import's analysis runs in.
 *
 * Analysis happens in a thread the user can watch, so the run reaching back for
 * its committed deck and pages is authorized through this mapping rather than
 * through anything the caller supplies: a run carries its `chat_thread_id`, and
 * only the import that owns that thread is reachable from it.
 *
 * The row is written before the first message is sent, so a run can never exist
 * without its import already recorded.
 */
export const presentationTemplateImportThreads = pgTable(
  "presentation_template_import_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(
        () => {
          return presentationTemplates.id;
        },
        { onDelete: "cascade" },
      ),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // One import analyses in one thread, and one thread analyses one import.
      uniqueIndex("idx_presentation_template_import_threads_template").on(
        table.templateId,
      ),
      uniqueIndex("idx_presentation_template_import_threads_thread").on(
        table.chatThreadId,
      ),
    ];
  },
);
