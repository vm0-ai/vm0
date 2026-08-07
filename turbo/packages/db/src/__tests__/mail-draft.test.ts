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
  it("drops follow_up_automation_id now that the pre-cleanup API has drained", () => {
    // Release 1 (PR #25540) removed every reader and kept the physical column
    // so the outgoing API, which still selected it explicitly in
    // linkMailFollowUp$, survived its drain window. That release has since been
    // promoted, so release 2 drops the column.
    expect(columnNames(mailDrafts).has("follow_up_automation_id")).toBe(false);
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
