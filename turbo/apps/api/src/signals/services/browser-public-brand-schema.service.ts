import type {
  BrowserStatus,
  BrowserSuspensionReason,
} from "@okouai/api-contracts/contracts/browser";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { browserSessions } from "@okouai/db/schema/browser-session";
import { eq, sql } from "drizzle-orm";
import {
  integer,
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

/**
 * The browser_sessions statement shape that existed before migration 0956.
 * Drizzle includes declared default columns in INSERT, so merely omitting
 * publicBrand from values would still reference the not-yet-created column.
 * Remove after the observed ~102-minute DB/API rollout and rollback window
 * closes with migration 0956 present everywhere; tracked by #28449.
 */
export const browserSessionsBeforePublicBrandMigration = pgTable(
  "browser_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    runId: uuid("run_id"),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    browserProfileId: uuid("browser_profile_id"),
    browserThreadProfileId: uuid("browser_thread_profile_id"),
    status: varchar("status", { length: 20 }).$type<BrowserStatus>().notNull(),
    proxyCountryCode: varchar("proxy_country_code", { length: 2 }),
    timeoutMinutes: integer("timeout_minutes").notNull(),
    suspendedAt: timestamp("suspended_at"),
    suspensionReason: varchar("suspension_reason", {
      length: 20,
    }).$type<BrowserSuspensionReason>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

/**
 * Read through the table's JSON shape so a new API can run before migration
 * 0956 adds public_brand. Missing values belong to legacy VM0 sessions;
 * malformed values are persisted-data corruption and must fail fast. Remove
 * with the pre-migration write model under #28449.
 */
export const browserSessionPublicBrandSelection = sql`
  to_jsonb(${browserSessions}) ->> 'public_brand'
`.mapWith(nullableDriverValueDecoder(pgTextDecoder));

export function browserSessionPublicBrand(value: unknown): PublicBrand {
  if (value === null || value === undefined) {
    return "vm0";
  }
  if (value === "vm0" || value === "okou") {
    return value;
  }
  throw new Error(`Invalid browser session public brand: ${String(value)}`);
}

export async function browserPublicBrandSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  // New API before migration compatibility for the observed ~102-minute
  // DB/API rollout window. Remove after migration 0956 is guaranteed
  // everywhere and the previous API rollback window closes; tracked by #28449.
  const [state] = await db
    .select({
      available: sql`
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass('public.browser_sessions')
            AND attname = 'public_brand'
            AND NOT attisdropped
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

export async function persistBrowserPublicBrandIfAvailable(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly publicBrand: PublicBrand;
  },
): Promise<boolean> {
  if (!(await browserPublicBrandSchemaAvailable(db))) {
    return false;
  }
  await db
    .update(browserSessions)
    .set({ publicBrand: args.publicBrand })
    .where(eq(browserSessions.chatThreadId, args.chatThreadId));
  return true;
}
