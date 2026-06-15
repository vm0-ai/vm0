import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Email Suppressions table
 * Stores bounced and complained email addresses to prevent future sends.
 * Checked during outbox drain to skip suppressed recipients.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    emailAddress: text("email_address").notNull(),
    reason: text("reason").notNull(), // 'bounced' | 'complained'
    resendEmailId: text("resend_email_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("email_suppressions_email_lower_idx").on(
        sql`lower(${table.emailAddress})`,
      ),
    ];
  },
);
