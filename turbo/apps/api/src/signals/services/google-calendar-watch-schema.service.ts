import { googleCalendarWatchStates } from "@vm0/db/schema/google-calendar-event";
import { getTableColumns, sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import type { Db } from "../external/db";

type GoogleCalendarWatchStateRow =
  typeof googleCalendarWatchStates.$inferSelect;

// This table shape intentionally omits migration 0835's transition columns.
// Drizzle names every declared insert column even when its value is DEFAULT,
// so the legacy shape keeps initial watch creation legal before 0835 lands.
const rolloutLegacyGoogleCalendarWatchStates = pgTable(
  "google_calendar_watch_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectorId: uuid("connector_id").notNull(),
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
);

export function rolloutCompatibleGoogleCalendarWatchStateColumns() {
  return {
    ...getTableColumns(googleCalendarWatchStates),
    previousChannelId:
      sql`to_jsonb(${googleCalendarWatchStates}) ->> 'previous_channel_id'`.mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
    previousChannelToken:
      sql`to_jsonb(${googleCalendarWatchStates}) ->> 'previous_channel_token'`.mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
    previousResourceId:
      sql`to_jsonb(${googleCalendarWatchStates}) ->> 'previous_resource_id'`.mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
  };
}

export async function googleCalendarWatchTransitionSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available: sql`
        EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = to_regclass('google_calendar_watch_states')
            AND attname = 'previous_channel_id'
            AND NOT attisdropped
        )
        AND EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = to_regclass('google_calendar_watch_states')
            AND attname = 'previous_channel_token'
            AND NOT attisdropped
        )
        AND EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = to_regclass('google_calendar_watch_states')
            AND attname = 'previous_resource_id'
            AND NOT attisdropped
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

interface RolloutCompatibleWatchValues {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly calendarId: string;
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
  readonly resourceUri: string;
  readonly previousChannelId: string | null;
  readonly previousChannelToken: string | null;
  readonly previousResourceId: string | null;
  readonly syncToken: string | null;
  readonly watchExpirationAt: Date;
  readonly lastWatchRenewedAt: Date;
  readonly needsRewatch: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RolloutCompatibleWatchSet {
  readonly orgId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
  readonly resourceUri: string;
  readonly previousChannelId: string | null;
  readonly previousChannelToken: string | null;
  readonly previousResourceId: string | null;
  readonly syncToken?: string | null;
  readonly watchExpirationAt: Date;
  readonly lastWatchRenewedAt: Date;
  readonly needsRewatch: boolean;
  readonly updatedAt: Date;
}

export async function upsertRolloutCompatibleGoogleCalendarWatchState(
  db: Db,
  args: {
    readonly transitionSchemaAvailable: boolean;
    readonly values: RolloutCompatibleWatchValues;
    readonly set: RolloutCompatibleWatchSet;
  },
): Promise<GoogleCalendarWatchStateRow | undefined> {
  if (args.transitionSchemaAvailable) {
    const [row] = await db
      .insert(googleCalendarWatchStates)
      .values(args.values)
      .onConflictDoUpdate({
        target: [
          googleCalendarWatchStates.connectorId,
          googleCalendarWatchStates.calendarId,
        ],
        set: args.set,
      })
      .returning();
    return row;
  }

  const [row] = await db
    .insert(rolloutLegacyGoogleCalendarWatchStates)
    .values({
      orgId: args.values.orgId,
      userId: args.values.userId,
      connectorId: args.values.connectorId,
      calendarId: args.values.calendarId,
      channelId: args.values.channelId,
      channelToken: args.values.channelToken,
      resourceId: args.values.resourceId,
      resourceUri: args.values.resourceUri,
      syncToken: args.values.syncToken,
      watchExpirationAt: args.values.watchExpirationAt,
      lastWatchRenewedAt: args.values.lastWatchRenewedAt,
      needsRewatch: args.values.needsRewatch,
      createdAt: args.values.createdAt,
      updatedAt: args.values.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        rolloutLegacyGoogleCalendarWatchStates.connectorId,
        rolloutLegacyGoogleCalendarWatchStates.calendarId,
      ],
      set: {
        orgId: args.set.orgId,
        userId: args.set.userId,
        channelId: args.set.channelId,
        channelToken: args.set.channelToken,
        resourceId: args.set.resourceId,
        resourceUri: args.set.resourceUri,
        ...(args.set.syncToken === undefined
          ? {}
          : { syncToken: args.set.syncToken }),
        watchExpirationAt: args.set.watchExpirationAt,
        lastWatchRenewedAt: args.set.lastWatchRenewedAt,
        needsRewatch: args.set.needsRewatch,
        updatedAt: args.set.updatedAt,
      },
    })
    .returning();
  return row
    ? {
        ...row,
        previousChannelId: null,
        previousChannelToken: null,
        previousResourceId: null,
      }
    : undefined;
}
