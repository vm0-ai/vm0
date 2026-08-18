import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export type WeeklyProductUpdateStatus = "pending" | "ready" | "skipped";

/**
 * weekly_product_updates — one row per Resend broadcast that announced a weekly
 * product update.
 *
 * Resend has no broadcast-level "sent" event: a broadcast emits one
 * `email.sent` per recipient, all carrying the same `broadcast_id`, in no
 * guaranteed order. `broadcast_id` is therefore the claim key — the first
 * event to insert its row owns the resolve/render work and every sibling event
 * is dropped.
 *
 * `post_slug` is the second dedupe key. Marketing has resent the same campaign
 * as a fresh broadcast before (and once alongside a `(Prod)` test copy with an
 * identical subject), so a new broadcast that points at an already-delivered
 * blog post must not deliver twice.
 */
export const weeklyProductUpdates = pgTable(
  "weekly_product_updates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    broadcastId: text("broadcast_id").notNull(),
    status: varchar("status", { length: 16 })
      .$type<WeeklyProductUpdateStatus>()
      .notNull()
      .default("pending"),
    // Slug of the linked whats-new-in-zero-week-of-* post. Null until the
    // broadcast is resolved, and left null on skipped rows.
    postSlug: text("post_slug"),
    postUrl: text("post_url"),
    subject: text("subject"),
    // Web Chat markdown, rendered once and reused for every delivery.
    message: text("message"),
    broadcastSentAt: timestamp("broadcast_sent_at"),
    // Set once a fan-out pass finds no member left to process.
    deliveredAt: timestamp("delivered_at"),
    skipReason: text("skip_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_weekly_product_updates_broadcast").on(table.broadcastId),
      uniqueIndex("idx_weekly_product_updates_post_slug")
        .on(table.postSlug)
        .where(sql`status = 'ready'`),
      index("idx_weekly_product_updates_status").on(table.status),
    ];
  },
);

/**
 * weekly_product_update_deliveries — one row per (update, member) that received
 * the update in Web Chat. The unique index is keyed on the user alone, not on
 * (org, user): a member of several orgs still gets exactly one copy.
 */
export const weeklyProductUpdateDeliveries = pgTable(
  "weekly_product_update_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    weeklyProductUpdateId: uuid("weekly_product_update_id")
      .notNull()
      .references(
        () => {
          return weeklyProductUpdates.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_weekly_product_update_deliveries_update_user").on(
        table.weeklyProductUpdateId,
        table.userId,
      ),
    ];
  },
);
