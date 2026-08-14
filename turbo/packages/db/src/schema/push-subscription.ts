import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

/**
 * Push Subscriptions table
 * Stores Web Push API subscriptions for sending push notifications to users.
 * Each row represents one device/browser subscription.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_push_subscriptions_user_id").on(table.userId),
      uniqueIndex("idx_push_subscriptions_endpoint").on(table.endpoint),
    ];
  },
);
