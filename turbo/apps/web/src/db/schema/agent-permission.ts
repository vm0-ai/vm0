import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";

/**
 * Agent Permissions table (ACL)
 * Stores access control entries for agent composes
 * - granteeType='public' means all authenticated users can access
 * - granteeType='email' means specific user by email can access
 */
export const agentPermissions = pgTable(
  "agent_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentComposeId: uuid("agent_compose_id")
      .notNull()
      .references(() => agentComposes.id, { onDelete: "cascade" }),
    granteeType: varchar("grantee_type", { length: 16 }).notNull(), // 'public', 'email'
    granteeEmail: text("grantee_email"), // NULL for public
    permission: varchar("permission", { length: 32 })
      .notNull()
      .default("run_view"),
    grantedBy: text("granted_by").notNull(), // Clerk user ID
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("agent_permissions_compose_type_email_unique").on(
      table.agentComposeId,
      table.granteeType,
      table.granteeEmail,
    ),
    index("idx_agent_permissions_compose").on(table.agentComposeId),
    index("idx_agent_permissions_email").on(table.granteeEmail),
  ],
);
