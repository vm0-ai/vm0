import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { teamsOrgInstallations } from "./teams-org-installation";

/**
 * Org-aware Microsoft Teams connections table.
 * Maps a Teams user to a VM0 user within a specific Teams tenant.
 */
export const teamsOrgConnections = pgTable(
  "teams_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamsUserId: varchar("teams_user_id", { length: 255 }).notNull(),
    teamsTenantId: varchar("teams_tenant_id", { length: 255 })
      .notNull()
      .references(() => {
        return teamsOrgInstallations.teamsTenantId;
      }),
    vm0UserId: text("vm0_user_id").notNull(),
    teamsUserDisplayName: varchar("teams_user_display_name", { length: 255 }),
    teamsUserPrincipalName: varchar("teams_user_principal_name", {
      length: 255,
    }),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_teams_org_connections_user_tenant").on(
        table.teamsUserId,
        table.teamsTenantId,
      ),
      index("idx_teams_org_connections_vm0_tenant").on(
        table.vm0UserId,
        table.teamsTenantId,
      ),
      index("idx_teams_org_connections_tenant").on(table.teamsTenantId),
    ];
  },
);
