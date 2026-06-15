import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { automationTriggers } from "./automation";
import { connectors } from "./connector";

export const gmailWatchStates = pgTable(
  "gmail_watch_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(
        () => {
          return connectors.id;
        },
        { onDelete: "cascade" },
      ),
    emailAddress: varchar("email_address", { length: 320 }).notNull(),
    topicName: text("topic_name").notNull(),
    lastHistoryId: varchar("last_history_id", { length: 64 }).notNull(),
    watchExpirationAt: timestamp("watch_expiration_at").notNull(),
    lastWatchRenewedAt: timestamp("last_watch_renewed_at").notNull(),
    needsRewatch: boolean("needs_rewatch").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_gmail_watch_states_connector_topic").on(
        table.connectorId,
        table.topicName,
      ),
      index("idx_gmail_watch_states_email_topic").on(
        table.emailAddress,
        table.topicName,
      ),
      index("idx_gmail_watch_states_renewal").on(table.watchExpirationAt),
    ];
  },
);

export const gmailProcessedEvents = pgTable(
  "gmail_processed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    watchStateId: uuid("watch_state_id")
      .notNull()
      .references(
        () => {
          return gmailWatchStates.id;
        },
        { onDelete: "cascade" },
      ),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(
        () => {
          return automationTriggers.id;
        },
        { onDelete: "cascade" },
      ),
    pubsubMessageId: varchar("pubsub_message_id", { length: 255 }),
    historyId: varchar("history_id", { length: 64 }).notNull(),
    messageId: varchar("message_id", { length: 128 }).notNull(),
    labelId: varchar("label_id", { length: 128 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_gmail_processed_events_event").on(
        table.watchStateId,
        table.triggerId,
        table.historyId,
        table.messageId,
        table.labelId,
      ),
      index("idx_gmail_processed_events_pubsub_message").on(
        table.pubsubMessageId,
      ),
    ];
  },
);
