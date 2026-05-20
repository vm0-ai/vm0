import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const connectorOauthStates = pgTable(
  "connector_oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    state: text("state").notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    sessionId: uuid("session_id"),
    codeVerifier: text("code_verifier"),
    oauthContext: text("oauth_context"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
  (table) => {
    return [
      uniqueIndex("idx_connector_oauth_states_state").on(table.state),
      index("idx_connector_oauth_states_user_org").on(
        table.userId,
        table.orgId,
      ),
      index("idx_connector_oauth_states_expires_at").on(table.expiresAt),
    ];
  },
);
