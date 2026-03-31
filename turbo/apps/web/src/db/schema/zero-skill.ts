import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Zero Skills table
 * Org-scoped registry of custom skills. Each row represents a custom skill
 * with its metadata. Skill content is stored in the storages system.
 */
export const zeroSkills = pgTable(
  "zero_skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      orgNameIdx: uniqueIndex("idx_zero_skills_org_name").on(
        table.orgId,
        table.name,
      ),
      orgIdx: index("idx_zero_skills_org").on(table.orgId),
    };
  },
);
