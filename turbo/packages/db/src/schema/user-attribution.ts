import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  ImportedAttributionSnapshot,
  ImportedDelivery,
  ImportedFirstTouch,
} from "../jsonb-contracts/user-attribution";

// No users FK: historical Clerk users may not have a local users row yet.
// This is a migration projection, not an authority for identity or consent.
export const userAttributionImports = pgTable("user_attribution_imports", {
  userId: text("user_id").primaryKey(),
  state: text("state")
    .$type<"absent" | "captured" | "invalid" | "conflict" | "deleted">()
    .notNull(),
  firstTouch: jsonb("first_touch").$type<ImportedFirstTouch>().notNull(),
  sourceUpdatedAt: timestamp("source_updated_at", {
    withTimezone: true,
    precision: 3,
  }).notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userAttributionImportSnapshots = pgTable(
  "user_attribution_import_snapshots",
  {
    userId: text("user_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    source: text("source").$type<"webhook" | "backfill">().notNull(),
    snapshot: jsonb("snapshot").$type<ImportedAttributionSnapshot>().notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.fingerprint] })];
  },
);

export const userAcquisitionDeliveryImports = pgTable(
  "user_acquisition_delivery_imports",
  {
    userId: text("user_id").notNull(),
    transactionId: text("transaction_id").notNull(),
    latest: jsonb("latest").$type<ImportedDelivery>().notNull(),
    accepted: jsonb("accepted").$type<ImportedDelivery>(),
    conflict: boolean("conflict").notNull().default(false),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.transactionId] })];
  },
);

// A checkpoint identifies committed user versions, never merely an offset.
export const userAttributionBackfillCheckpoints = pgTable(
  "user_attribution_backfill_checkpoints",
  {
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.runId, table.userId] }),
      index("user_attribution_backfill_user_idx").on(table.userId),
    ];
  },
);
