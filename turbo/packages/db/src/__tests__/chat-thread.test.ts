import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { chatThreads } from "../schema/chat-thread";

describe("chatThreads schema", () => {
  it("keeps physical draft userMessage storage nullable for empty drafts", () => {
    const columns = new Map(
      getTableConfig(chatThreads).columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(columns.get("draft_structured_prompt")).toBe(false);
  });
});
