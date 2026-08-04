import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import { chatAgentRunContext } from "../schema/chat-agent-run-context";
import { chatEvents } from "../schema/chat-event";

describe("chatAgentRunContext schema", () => {
  it("exports durable source-run provenance without live-entity references", () => {
    const config = getTableConfig(chatAgentRunContext);
    const columns = new Map(
      config.columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(schema.chatAgentRunContext).toBe(chatAgentRunContext);
    expect(columns).toEqual(
      new Map([
        ["id", true],
        ["source_chat_thread_id", true],
        ["source_agent_id", true],
        ["created_at", true],
      ]),
    );
    expect(config.foreignKeys).toHaveLength(0);
  });
});

describe("chatEvents schema", () => {
  it("exposes only canonical userMessage storage", () => {
    const columns = new Map(
      getTableConfig(chatEvents).columns.map((column) => {
        return [column.name, column.notNull] as const;
      }),
    );

    expect(columns.has("structured_prompt")).toBe(false);
    expect(columns.get("user_message")).toBe(false);
  });

  it("keeps run references after runs are deleted", () => {
    const foreignKeys = getTableConfig(chatEvents).foreignKeys.map(
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
        columns: ["revokes_event_id"],
        name: "chat_events_revokes_event_id_chat_events_id_fk",
        onDelete: "no action",
      },
    ]);
  });
});
