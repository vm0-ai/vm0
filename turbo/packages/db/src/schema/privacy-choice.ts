import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PrivacyPurposes } from "@okouai/api-contracts/contracts/privacy-choices";

// Personal choices are independent of organization membership. Browser tokens
// authorize only this preference; no raw token or advertising ID is retained.
export const privacyChoices = pgTable(
  "privacy_choices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").unique(),
    tokenHash: text("token_hash").unique(),
    linkedUserId: text("linked_user_id"),
    revision: uuid("revision").notNull().defaultRandom(),
    saleSharing: text("sale_sharing")
      .$type<PrivacyPurposes["saleSharing"]>()
      .notNull()
      .default("unknown"),
    advertising: text("advertising")
      .$type<PrivacyPurposes["advertising"]>()
      .notNull()
      .default("unknown"),
    marketingAnalytics: text("marketing_analytics")
      .$type<PrivacyPurposes["marketingAnalytics"]>()
      .notNull()
      .default("unknown"),
    source: text("source").$type<"explicit" | "gpc">(),
    policyVersion: text("policy_version").notNull(),
    updatedAt: timestamp("updated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      index("privacy_choices_linked_user_idx").on(table.linkedUserId),
      check(
        "privacy_choices_owner_check",
        sql`(${table.userId} IS NOT NULL AND ${table.tokenHash} IS NULL AND ${table.linkedUserId} IS NULL) OR (${table.userId} IS NULL AND ${table.tokenHash} IS NOT NULL)`,
      ),
    ];
  },
);

// Immutable evidence for event-time consent. Delivery must also consult the
// current subject (and its linked person); a historical revision is not a grant.
export const privacyChoiceRevisions = pgTable(
  "privacy_choice_revisions",
  {
    revision: uuid("revision").primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(
        () => {
          return privacyChoices.id;
        },
        { onDelete: "cascade" },
      ),
    saleSharing: text("sale_sharing")
      .$type<PrivacyPurposes["saleSharing"]>()
      .notNull(),
    advertising: text("advertising")
      .$type<PrivacyPurposes["advertising"]>()
      .notNull(),
    marketingAnalytics: text("marketing_analytics")
      .$type<PrivacyPurposes["marketingAnalytics"]>()
      .notNull(),
    source: text("source").$type<"explicit" | "gpc">().notNull(),
    policyVersion: text("policy_version").notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
  },
  (table) => {
    return [index("privacy_choice_revisions_subject_idx").on(table.subjectId)];
  },
);
