import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { mailDrafts } from "../schema/mail-draft";

describe("mailDrafts schema", () => {
  it("requires the linked Gmail draft identity and summary", () => {
    const columns = new Map(
      getTableConfig(mailDrafts).columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    for (const name of [
      "chat_thread_id",
      "gmail_draft_id",
      "gmail_thread_id",
      "gmail_message_id",
      "status",
      "sender_address",
      "subject",
    ]) {
      expect(columns.get(name), name).toBeTruthy();
    }
    for (const name of [
      "connector_id",
      "sent_gmail_message_id",
      "sender_name",
      "sent_at",
    ]) {
      expect(columns.get(name), name).toBeFalsy();
    }
    expect(columns.get("id")).toBeTruthy();
    expect(columns.get("created_at")).toBeTruthy();
    expect(columns.get("updated_at")).toBeTruthy();
  });
});
