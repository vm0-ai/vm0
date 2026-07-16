import { jsonb, pgTable, uuid } from "drizzle-orm/pg-core";
import type { MailDraftData } from "@vm0/db/jsonb-contracts/mail-draft";

export const mailDrafts = pgTable("mail_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  draft: jsonb("draft").$type<MailDraftData>().notNull(),
});
