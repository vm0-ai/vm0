import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Computer-use hosts table
 * Stores registered computer-use host sessions with ngrok resource IDs.
 * Each user in an org can have at most one active host registration.
 */
export const computerUseHosts = pgTable(
  "computer_use_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    domain: text("domain").notNull(),
    token: text("token").notNull(),

    // ngrok resource IDs for cleanup on unregister
    ngrokBotUserId: text("ngrok_bot_user_id"),
    ngrokCredentialId: text("ngrok_credential_id"),
    ngrokEndpointId: text("ngrok_endpoint_id"),
    ngrokDomainId: text("ngrok_domain_id"),

    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_computer_use_hosts_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_computer_use_hosts_org").on(table.orgId),
    ];
  },
);
