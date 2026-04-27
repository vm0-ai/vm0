import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";

/**
 * Email Outbox table
 * Queues outbound emails for rate-limited delivery via Resend.
 * Stores template name + props (not pre-rendered HTML) so templates
 * are rendered at send time with the latest version.
 *
 * Drain worker processes pending items at ≤2 req/s.
 * Items are retried up to 3 times with exponential backoff.
 * Expired items (>15 min) are cleaned up by cron.
 */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Email envelope
    fromAddress: text("from_address").notNull(),
    toAddresses: jsonb("to_addresses").notNull(), // string | string[]
    ccAddresses: jsonb("cc_addresses"), // string | string[] | null
    subject: text("subject").notNull(),
    replyTo: text("reply_to"),
    headers: jsonb("headers"), // Record<string, string> | null

    // Template (discriminated union stored as JSONB)
    template: jsonb("template").notNull(), // EmailTemplate

    // Post-send action for email threading (discriminated union)
    postSendAction: jsonb("post_send_action"), // PostSendAction | null

    // Queue status
    status: text("status").notNull().default("pending"), // pending | sending | sent | failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextRetryAt: timestamp("next_retry_at"),
    resendId: text("resend_id"), // Resend internal ID (filled after send)

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Drain query: pending items ready to send, FIFO order
      index("email_outbox_drain_idx").on(
        table.status,
        table.nextRetryAt,
        table.createdAt,
      ),
      // TTL cleanup
      index("email_outbox_created_at_idx").on(table.createdAt),
    ];
  },
);
