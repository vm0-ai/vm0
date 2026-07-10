import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const userArtifactFavorites = pgTable(
  "user_artifact_favorites",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    artifactUrl: text("artifact_url").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.orgId, table.userId, table.artifactUrl],
      }),
    ];
  },
);
