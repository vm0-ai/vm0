import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { mailDrafts } from "../schema/mail-draft";

describe("mailDrafts schema", () => {
  it("accepts old and new API writes during the rolling deployment window", () => {
    const columns = new Map(
      getTableConfig(mailDrafts).columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(columns.get("draft")).toBeFalsy();
    for (const name of [
      "chat_thread_id",
      "connector_id",
      "gmail_draft_id",
      "gmail_thread_id",
      "gmail_message_id",
      "sent_gmail_message_id",
      "status",
      "sender_name",
      "sender_address",
      "subject",
      "sent_at",
    ]) {
      expect(columns.get(name), name).toBeFalsy();
    }
    expect(columns.get("id")).toBeTruthy();
    expect(columns.get("created_at")).toBeTruthy();
    expect(columns.get("updated_at")).toBeTruthy();
  });
});
