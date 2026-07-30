import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { zeroAgentDrafts } from "../schema/zero-agent-draft";

describe("zeroAgentDrafts schema", () => {
  it("exposes only canonical draft userMessage storage", () => {
    const columns = new Map(
      getTableConfig(zeroAgentDrafts).columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(columns.has("draft_structured_prompt")).toBe(false);
    expect(columns.get("draft_user_message")).toBe(false);
  });
});
