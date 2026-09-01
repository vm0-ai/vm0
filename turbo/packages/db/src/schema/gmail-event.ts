import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { connectors } from "./connector";
import { workflowAutomations } from "./workflow";

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

export const gmailWatchCleanupIntents = pgTable(
  "gmail_watch_cleanup_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mailboxKey: text("mailbox_key").notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 }),
    emailAddress: varchar("email_address", { length: 320 }).notNull(),
    topicNames: text("topic_names").array().notNull(),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    storageVersion: bigint("storage_version", { mode: "number" }).notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    watchExpirationAt: timestamp("watch_expiration_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_gmail_watch_cleanup_intents_mailbox").on(
        table.mailboxKey,
      ),
      index("idx_gmail_watch_cleanup_intents_expiration").on(
        table.watchExpirationAt,
      ),
      index("idx_gmail_watch_cleanup_intents_provider_account").on(
        table.providerAccountId,
      ),
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
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    pubsubMessageId: varchar("pubsub_message_id", { length: 255 }),
    historyId: varchar("history_id", { length: 64 }).notNull(),
    messageId: varchar("message_id", { length: 128 }).notNull(),
    threadId: varchar("thread_id", { length: 128 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_gmail_processed_events_automation_event").on(
        table.watchStateId,
        table.automationId,
        table.historyId,
        table.messageId,
      ),
      index("idx_gmail_processed_events_pubsub_message").on(
        table.pubsubMessageId,
      ),
    ];
  },
);
