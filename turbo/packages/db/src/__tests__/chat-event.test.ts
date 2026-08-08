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
  it("exposes the final canonical stream shape", () => {
    const config = getTableConfig(chatEvents);

    expect(schema.chatEvents).toBe(chatEvents);
    expect(
      config.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual([
      "id",
      "chat_thread_id",
      "run_id",
      "usage_payload",
      "revokes_event_id",
      "interrupts_run_id",
      "run_group_id",
      "event_type",
      "context_type",
      "context_id",
      "content",
      "user_message",
      "thinking",
      "error",
      "run_event_sequence_number",
      "run_event_id",
      "seq_id",
      "created_at",
    ]);
    expect(
      config.indexes
        .map((index) => {
          return index.config.name;
        })
        .sort(),
    ).toStrictEqual([
      "chat_events_input_automation_context_idx",
      "chat_events_interrupts_run_id_not_null_unique",
      "chat_events_pending_queue_idx",
      "chat_events_revokes_event_id_not_null_unique",
      "chat_events_run_event_seq_unique",
      "chat_events_run_terminal_unique",
      "chat_events_run_thinking_unique",
      "chat_events_thread_seq_unique",
      "chat_events_usage_run_id_idx",
      "idx_chat_events_run_id",
      "idx_chat_events_thread_created",
      "idx_chat_events_thread_run_terminal_created",
    ]);
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
