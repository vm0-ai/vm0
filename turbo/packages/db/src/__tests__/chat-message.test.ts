import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { chatMessages } from "../schema/chat-message";

describe("chatMessages schema", () => {
  it("keeps physical userMessage storage nullable for non-input events", () => {
    const columns = new Map(
      getTableConfig(chatMessages).columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(columns.get("structured_prompt")).toBe(false);
  });

  it("keeps run references after runs are deleted", () => {
    const foreignKeys = getTableConfig(chatMessages).foreignKeys.map(
      (foreignKey) => {
        const reference = foreignKey.reference();
        return {
          columns: reference.columns.map((column) => {
            return column.name;
          }),
          name: foreignKey.getName(),
          onDelete: foreignKey.onDelete,
        };
      },
    );

    expect(foreignKeys).toEqual([
      {
        columns: ["chat_thread_id"],
        name: "chat_events_chat_thread_id_chat_threads_id_fk",
        onDelete: "cascade",
      },
      {
        columns: ["revokes_message_id"],
        name: "chat_events_revokes_message_id_chat_events_id_fk",
        onDelete: "no action",
      },
    ]);
  });
});
