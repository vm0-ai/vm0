import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Resend Contact Mapping table
 * Maps Clerk user IDs to Resend contact IDs and stores the last-synced
 * email/name so the daily reconcile cron can diff against Clerk and only
 * enqueue real changes.
 */
export const resendContactMapping = pgTable("resend_contact_mapping", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  resendContactId: text("resend_contact_id").notNull(),
  lastEmail: text("last_email").notNull(),
  lastFirstName: text("last_first_name"),
  lastLastName: text("last_last_name"),
  syncedAt: timestamp("synced_at").defaultNow().notNull(),
});
