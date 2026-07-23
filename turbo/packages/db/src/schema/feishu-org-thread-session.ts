import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentSessions } from "./agent-session";
import { feishuOrgConnections } from "./feishu-org-connection";

export const feishuOrgThreadSessions = pgTable(
  "feishu_org_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return feishuOrgConnections.id;
        },
        { onDelete: "cascade" },
      ),
    feishuChatId: varchar("feishu_chat_id", { length: 255 }).notNull(),
    agentSessionId: uuid("agent_session_id").references(
      () => {
        return agentSessions.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_feishu_org_thread_sessions_conn_chat").on(
        table.connectionId,
        table.feishuChatId,
      ),
      index("idx_feishu_org_thread_sessions_connection").on(table.connectionId),
    ];
  },
);
