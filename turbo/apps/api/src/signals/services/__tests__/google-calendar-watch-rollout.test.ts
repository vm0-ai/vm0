import { randomUUID } from "node:crypto";

import { googleCalendarWatchStates } from "@vm0/db/schema/google-calendar-event";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "../../../lib/db";
import {
  googleCalendarWatchTransitionSchemaAvailable,
  rolloutCompatibleGoogleCalendarWatchStateColumns,
  upsertRolloutCompatibleGoogleCalendarWatchState,
} from "../google-calendar-watch-schema.service";

function watchUpsertArgs(args: {
  readonly connectorId: string;
  readonly channelId: string;
  readonly previousChannelId: string | null;
}) {
  const currentTime = new Date("2026-08-05T08:00:00.000Z");
  const values = {
    orgId: "org_calendar_rollout",
    userId: "user_calendar_rollout",
    connectorId: args.connectorId,
    calendarId: "primary",
    channelId: args.channelId,
    channelToken: `token-${args.channelId}`,
    resourceId: `resource-${args.channelId}`,
    resourceUri: "https://calendar.example.test/events",
    previousChannelId: args.previousChannelId,
    previousChannelToken: args.previousChannelId
      ? `token-${args.previousChannelId}`
      : null,
    previousResourceId: args.previousChannelId
      ? `resource-${args.previousChannelId}`
      : null,
    syncToken: "sync-rollout",
    watchExpirationAt: new Date("2026-08-12T08:00:00.000Z"),
    lastWatchRenewedAt: currentTime,
    needsRewatch: false,
    createdAt: currentTime,
    updatedAt: currentTime,
  };
  return {
    values,
    set: {
      orgId: values.orgId,
      userId: values.userId,
      channelId: values.channelId,
      channelToken: values.channelToken,
      resourceId: values.resourceId,
      resourceUri: values.resourceUri,
      previousChannelId: values.previousChannelId,
      previousChannelToken: values.previousChannelToken,
      previousResourceId: values.previousResourceId,
      syncToken: values.syncToken,
      watchExpirationAt: values.watchExpirationAt,
      lastWatchRenewedAt: values.lastWatchRenewedAt,
      needsRewatch: values.needsRewatch,
      updatedAt: values.updatedAt,
    },
  };
}

describe("Google Calendar watch rollout compatibility", () => {
  it("keeps reads and initial watch writes legal before migration 0835", async () => {
    const rollback = new Error("rollback Calendar watch rollout fixture");

    await expect(
      db().transaction(async (tx) => {
        await tx.execute(sql`
          CREATE TEMP TABLE google_calendar_watch_states
          (LIKE public.google_calendar_watch_states INCLUDING ALL)
          ON COMMIT DROP
        `);
        await tx.execute(sql`SET LOCAL search_path TO pg_temp, public`);

        await expect(
          googleCalendarWatchTransitionSchemaAvailable(tx),
        ).resolves.toBeTruthy();
        const migratedArgs = watchUpsertArgs({
          connectorId: randomUUID(),
          channelId: randomUUID(),
          previousChannelId: randomUUID(),
        });
        const migrated = await upsertRolloutCompatibleGoogleCalendarWatchState(
          tx,
          {
            transitionSchemaAvailable: true,
            ...migratedArgs,
          },
        );
        if (!migrated) {
          throw new Error("Expected migrated Calendar watch state");
        }
        expect(migrated.previousChannelId).toBe(
          migratedArgs.values.previousChannelId,
        );

        await tx.execute(sql`
          ALTER TABLE pg_temp.google_calendar_watch_states
          DROP COLUMN previous_channel_id,
          DROP COLUMN previous_channel_token,
          DROP COLUMN previous_resource_id
        `);
        await expect(
          googleCalendarWatchTransitionSchemaAvailable(tx),
        ).resolves.toBeFalsy();

        const columns = rolloutCompatibleGoogleCalendarWatchStateColumns();
        const [migratedRead] = await tx
          .select(columns)
          .from(googleCalendarWatchStates)
          .where(eq(googleCalendarWatchStates.id, migrated.id))
          .limit(1);
        expect(migratedRead).toMatchObject({
          id: migrated.id,
          previousChannelId: null,
          previousChannelToken: null,
          previousResourceId: null,
        });

        const legacyArgs = watchUpsertArgs({
          connectorId: randomUUID(),
          channelId: randomUUID(),
          previousChannelId: null,
        });
        const legacy = await upsertRolloutCompatibleGoogleCalendarWatchState(
          tx,
          {
            transitionSchemaAvailable: false,
            ...legacyArgs,
          },
        );
        expect(legacy).toMatchObject({
          connectorId: legacyArgs.values.connectorId,
          channelId: legacyArgs.values.channelId,
          previousChannelId: null,
          previousChannelToken: null,
          previousResourceId: null,
        });

        await expect(
          tx
            .select({ id: googleCalendarWatchStates.id })
            .from(googleCalendarWatchStates)
            .where(eq(columns.previousChannelId, randomUUID())),
        ).resolves.toStrictEqual([]);

        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
