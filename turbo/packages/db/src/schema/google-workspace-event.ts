import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { connectors } from "./connector";
import { zeroWorkflowTriggers } from "./zero-workflow";

export type GoogleWorkspaceEventProvider = "google-meet";

export const googleWorkspaceEventSubscriptionStates = pgTable(
  "google_workspace_event_subscription_states",
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
    provider: varchar("provider", { length: 64 })
      .$type<GoogleWorkspaceEventProvider>()
      .notNull(),
    targetResource: text("target_resource").notNull(),
    eventTypes: jsonb("event_types").$type<readonly string[]>().notNull(),
    eventTypesKey: text("event_types_key").notNull(),
    subscriptionName: varchar("subscription_name", { length: 255 }).notNull(),
    pubsubTopic: text("pubsub_topic").notNull(),
    state: varchar("state", { length: 64 }),
    expireTime: timestamp("expire_time").notNull(),
    lastRenewedAt: timestamp("last_renewed_at").notNull(),
    needsRepair: boolean("needs_repair").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_google_workspace_event_subscription_scope").on(
        table.connectorId,
        table.provider,
        table.targetResource,
        table.pubsubTopic,
        table.eventTypesKey,
      ),
      uniqueIndex("idx_google_workspace_event_subscription_name").on(
        table.subscriptionName,
      ),
      index("idx_google_workspace_event_subscription_owner").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
      index("idx_google_workspace_event_subscription_renewal").on(
        table.expireTime,
      ),
    ];
  },
);

export const googleWorkspaceProcessedEvents = pgTable(
  "google_workspace_processed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionStateId: uuid("subscription_state_id")
      .notNull()
      .references(
        () => {
          return googleWorkspaceEventSubscriptionStates.id;
        },
        { onDelete: "cascade" },
      ),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflowTriggers.id;
        },
        { onDelete: "cascade" },
      ),
    pubsubMessageId: varchar("pubsub_message_id", { length: 255 }),
    cloudEventId: varchar("cloud_event_id", { length: 255 }).notNull(),
    cloudEventType: varchar("cloud_event_type", { length: 255 }).notNull(),
    conferenceRecordName: text("conference_record_name"),
    transcriptName: text("transcript_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_google_workspace_processed_events_cloudevent").on(
        table.subscriptionStateId,
        table.triggerId,
        table.cloudEventId,
      ),
      uniqueIndex("idx_google_workspace_processed_events_transcript").on(
        table.subscriptionStateId,
        table.triggerId,
        table.transcriptName,
      ),
      index("idx_google_workspace_processed_events_pubsub_message").on(
        table.pubsubMessageId,
      ),
    ];
  },
);
