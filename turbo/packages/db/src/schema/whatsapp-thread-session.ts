import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-session";
import { whatsappUserLinks } from "./whatsapp-user-link";

export const whatsappThreadSessions = pgTable(
  "whatsapp_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    whatsappUserLinkId: uuid("whatsapp_user_link_id")
      .notNull()
      .references(
        () => {
          return whatsappUserLinks.id;
        },
        { onDelete: "cascade" },
      ),
    rootMessageId: varchar("root_message_id", { length: 255 }).notNull(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(
        () => {
          return agentSessions.id;
        },
        { onDelete: "cascade" },
      ),
    lastProcessedMessageId: varchar("last_processed_message_id", {
      length: 255,
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_whatsapp_thread_sessions_link_root").on(
        table.whatsappUserLinkId,
        table.rootMessageId,
      ),
      index("idx_whatsapp_thread_sessions_user_link").on(
        table.whatsappUserLinkId,
      ),
    ];
  },
);
