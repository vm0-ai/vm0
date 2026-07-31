import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { chatThreads } from "./chat-thread";

export const chatGithubContext = pgTable(
  "chat_github_context",
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
    repo: text("repo").notNull(),
    subjectNumber: integer("subject_number").notNull(),
    subjectKind: text("subject_kind")
      .$type<"issue" | "pull_request">()
      .notNull(),
    triggerCommentId: text("trigger_comment_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chat_github_context_subject_kind_check",
        sql`${table.subjectKind} IN ('issue', 'pull_request')`,
      ),
    ];
  },
);
