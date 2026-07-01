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

export const googleCalendarWatchStates = pgTable(
  "google_calendar_watch_states",
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
    calendarId: text("calendar_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    channelToken: varchar("channel_token", { length: 255 }).notNull(),
    resourceId: varchar("resource_id", { length: 255 }).notNull(),
    resourceUri: text("resource_uri").notNull(),
    syncToken: text("sync_token"),
    watchExpirationAt: timestamp("watch_expiration_at").notNull(),
    lastWatchRenewedAt: timestamp("last_watch_renewed_at").notNull(),
    needsRewatch: boolean("needs_rewatch").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_google_calendar_watch_states_connector_calendar").on(
        table.connectorId,
        table.calendarId,
      ),
      uniqueIndex("idx_google_calendar_watch_states_channel").on(
        table.channelId,
      ),
      index("idx_google_calendar_watch_states_resource").on(table.resourceId),
      index("idx_google_calendar_watch_states_renewal").on(
        table.watchExpirationAt,
      ),
    ];
  },
);

export const googleCalendarEventSnapshots = pgTable(
  "google_calendar_event_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    watchStateId: uuid("watch_state_id")
      .notNull()
      .references(
        () => {
          return googleCalendarWatchStates.id;
        },
        { onDelete: "cascade" },
      ),
    calendarEventId: varchar("calendar_event_id", { length: 1024 }).notNull(),
    etag: varchar("etag", { length: 255 }),
    status: varchar("status", { length: 64 }),
    eventType: varchar("event_type", { length: 64 }),
    summary: text("summary"),
    startAt: timestamp("start_at"),
    endAt: timestamp("end_at"),
    eventCreatedAt: timestamp("event_created_at"),
    eventUpdatedAt: timestamp("event_updated_at"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_google_calendar_event_snapshots_event").on(
        table.watchStateId,
        table.calendarEventId,
      ),
      index("idx_google_calendar_event_snapshots_updated").on(
        table.eventUpdatedAt,
      ),
    ];
  },
);

export const googleCalendarProcessedEvents = pgTable(
  "google_calendar_processed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    watchStateId: uuid("watch_state_id")
      .notNull()
      .references(
        () => {
          return googleCalendarWatchStates.id;
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
    channelId: uuid("channel_id").notNull(),
    resourceState: varchar("resource_state", { length: 64 }).notNull(),
    calendarEventId: varchar("calendar_event_id", { length: 1024 }).notNull(),
    eventChangeKey: text("event_change_key").notNull().default("created"),
    eventCreatedAt: timestamp("event_created_at"),
    eventUpdatedAt: timestamp("event_updated_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_google_calendar_processed_events_event").on(
        table.watchStateId,
        table.triggerId,
        table.calendarEventId,
        table.eventChangeKey,
      ),
      index("idx_google_calendar_processed_events_channel").on(table.channelId),
    ];
  },
);
