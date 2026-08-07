import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { chatThreads } from "../schema/chat-thread";
import { deviceCodes } from "../schema/device-codes";
import { mailDrafts } from "../schema/mail-draft";

function columnNames(table: Parameters<typeof getTableConfig>[0]): Set<string> {
  return new Set(
    getTableConfig(table).columns.map((column) => {
      return column.name;
    }),
  );
}

describe("retired column contraction", () => {
  it("keeps follow_up_automation_id declared while the pre-cleanup API drains", () => {
    // The outgoing API release still selects this column explicitly in
    // linkMailFollowUp$, and migrations run before API traffic is promoted.
    // Dropping the physical column in the same release would fail those
    // statements with 42703 until the old API finishes draining.
    expect(columnNames(mailDrafts).has("follow_up_automation_id")).toBe(true);
  });

  it("drops mail draft and chat thread columns no deployed reader names", () => {
    expect(columnNames(mailDrafts).has("draft")).toBe(false);
    expect(columnNames(chatThreads).has("generation_template")).toBe(false);
  });

  it("drops retired device code columns", () => {
    const columns = columnNames(deviceCodes);

    for (const retired of [
      "purpose",
      "ble_session_nonce",
      "poll_token_hash",
      "poll_interval_seconds",
      "cli_token_id",
      "chat_thread_id",
      "approved_at",
      "consumed_at",
    ]) {
      expect(columns.has(retired)).toBe(false);
    }
  });
});
