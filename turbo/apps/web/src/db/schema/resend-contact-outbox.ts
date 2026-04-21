import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";

/**
 * Resend Contact Outbox table
 * Queues create/update/delete ops against Resend's Contacts API for
 * rate-limited delivery (≤2 req/s shared with email_outbox).
 *
 * Drain worker processes pending items at ≤2 req/s.
 * Items are retried up to 3 times with exponential backoff (1s / 4s / 16s).
 * Expired items (>60 min) are cleaned up alongside drain.
 */
export const resendContactOutbox = pgTable(
  "resend_contact_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Op payload
    op: text("op").notNull(), // 'create' | 'update' | 'delete'
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email"), // nullable for delete
    firstName: text("first_name"),
    lastName: text("last_name"),

    // Queue status
    status: text("status").notNull().default("pending"), // pending | sending | done | failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextRetryAt: timestamp("next_retry_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("resend_contact_outbox_drain_idx").on(
        table.status,
        table.nextRetryAt,
        table.createdAt,
      ),
      index("resend_contact_outbox_created_at_idx").on(table.createdAt),
    ];
  },
);
