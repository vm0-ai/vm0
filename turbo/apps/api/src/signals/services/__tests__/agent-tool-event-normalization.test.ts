import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../lib/event-consumer/verify";
import { normalizeAgentToolEvent } from "../agent-tool-event-normalization";
import {
  assistantEventIdForRunEvent,
  toolEventIdForRunEvent,
  toolUseIdForProviderOperation,
  toolUseIdForRunEvent,
} from "../assistant-event-id";

const RUN_ID = "8de6b4bf-d92a-4599-bde7-614e72552365";

function agentEvent(
  sequenceNumber: number,
  event: { readonly type: string; readonly [key: string]: unknown },
): AgentEvent {
  return { ...event, sequenceNumber };
}

function quoteShellArgumentForFixture(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function quoteDoubleShellArgumentForFixture(value: string): string {
  const escape = String.fromCodePoint(92);
  let quoted = '"';
  for (const character of value) {
    if (
      character === escape ||
      character === '"' ||
      character === "$" ||
      character === "`"
    ) {
      quoted += escape;
    }
    quoted += character;
  }
  return `${quoted}"`;
}

function claudeToolUse(args: {
  readonly id?: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}): AgentEvent {
  return agentEvent(1, {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: args.id ?? "claude-operation-1",
          name: args.name,
          input: args.input,
        },
      ],
    },
  });
}

function codexItem(
  eventType: "item.started" | "item.completed",
  item: Record<string, unknown>,
): AgentEvent {
  return agentEvent(1, { type: eventType, item });
}

describe("agent tool event normalization", () => {
  it("maps the exact Claude Code V1 actions and result status", () => {
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "bAsH",
          input: { command: "  printf\t'***'\n  " },
        }),
      ),
    ).toStrictEqual({
      kind: "correlated",
      provider: "claude",
      providerOperationId: "claude-operation-1",
      action: "run",
      status: "pending",
      summary: "Ran printf '***'",
    });
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "Read",
          input: { file_path: " /workspace/a.ts " },
        }),
      ),
    ).toMatchObject({ action: "read", summary: "Read /workspace/a.ts" });
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "Write",
          input: { file_path: "/workspace/b.ts" },
        }),
      ),
    ).toMatchObject({ action: "write", summary: "Wrote /workspace/b.ts" });
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "Edit",
          input: { file_path: "/workspace/c.ts" },
        }),
      ),
    ).toMatchObject({ action: "edit", summary: "Edited /workspace/c.ts" });
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "NotebookEdit",
          input: {
            notebook_path: "  ",
            file_path: "/workspace/notebook.ipynb",
          },
        }),
      ),
    ).toMatchObject({
      action: "edit",
      summary: "Edited /workspace/notebook.ipynb",
    });

    expect(
      normalizeAgentToolEvent(
        agentEvent(2, {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "claude-operation-1",
                is_error: true,
                content: "raw error must not be projected",
              },
            ],
          },
        }),
      ),
    ).toStrictEqual({
      kind: "correlated-terminal",
      provider: "claude",
      providerOperationId: "claude-operation-1",
      status: "error",
    });
    expect(
      normalizeAgentToolEvent(
        agentEvent(3, {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "claude-operation-1",
                is_error: false,
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ status: "success" });
  });

  it("round-trips the exact managed and outer Codex command wrappers", () => {
    const command = `printf '%s\\n' "$HOME"`;
    const managed = `exec '/usr/local/bin/guest-tool-exec' --shell "$0" -c ${quoteShellArgumentForFixture(command)}`;
    expect(managed).toBe(
      `exec '/usr/local/bin/guest-tool-exec' --shell "$0" -c 'printf '\\''%s\\n'\\'' "$HOME"'`,
    );

    for (const option of ["-c", "-lc"] as const) {
      for (const outerArgument of [
        quoteDoubleShellArgumentForFixture(managed),
        quoteShellArgumentForFixture(managed),
      ]) {
        expect(
          normalizeAgentToolEvent(
            codexItem("item.started", {
              id: `codex-${option}`,
              type: "command_execution",
              status: "in_progress",
              command: `/bin/bash ${option} ${outerArgument}`,
            }),
          ),
        ).toMatchObject({
          action: "run",
          status: "pending",
          summary: `Ran printf '%s\\n' "$HOME"`,
        });
      }
    }
  });

  it("bounds summaries without splitting surrogate pairs", () => {
    const normalized = normalizeAgentToolEvent(
      claudeToolUse({
        name: "Read",
        input: { file_path: `${"a".repeat(233)}😀tail` },
      }),
    );
    expect(normalized).toMatchObject({
      summary: `Read ${"a".repeat(233)}…`,
    });
    if (normalized?.kind !== "correlated") {
      throw new Error("Expected a correlated Claude tool event");
    }
    expect(normalized.summary.length).toBeLessThanOrEqual(240);
    expect(normalized.summary.match(/…/gu)).toHaveLength(1);
  });

  it("omits malformed, unsafe, multi-block, and unsupported Claude operations", () => {
    for (const event of [
      claudeToolUse({ name: "Search", input: { query: "needle" } }),
      claudeToolUse({ name: "Read", input: { file_path: "   " } }),
      claudeToolUse({ name: "Read", input: { file_path: "bad\0path" } }),
      claudeToolUse({ id: " ", name: "Read", input: { file_path: "a" } }),
      claudeToolUse({
        name: "Bash",
        input: { command: "/bin/bash -lc 'unterminated" },
      }),
      claudeToolUse({
        name: "Bash",
        input: { command: '/bin/bash -lc "echo $HOME"' },
      }),
      claudeToolUse({
        name: "Bash",
        input: {
          command:
            "exec '/usr/local/bin/guest-tool-exec' --wrong \"$0\" -c 'pwd'",
        },
      }),
      agentEvent(2, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "multi-1",
              name: "Read",
              input: { file_path: "a" },
            },
            { type: "text", text: "not normalized" },
          ],
        },
      }),
    ]) {
      expect(normalizeAgentToolEvent(event)).toBeNull();
    }

    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "Bash",
          input: {
            command:
              "printf '%s' \"exec '/usr/local/bin/guest-tool-exec' --shell\"",
          },
        }),
      ),
    ).toMatchObject({
      summary:
        "Ran printf '%s' \"exec '/usr/local/bin/guest-tool-exec' --shell\"",
    });
  });

  it("maps Codex command and completed-only file status without generic fallbacks", () => {
    const completedCommand = {
      id: "codex-command",
      type: "command_execution",
      status: "completed",
      command: "pwd",
    };
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", { ...completedCommand, exit_code: 0 }),
      ),
    ).toMatchObject({
      kind: "correlated-terminal",
      provider: "codex",
      status: "success",
      standaloneOperation: { action: "run", summary: "Ran pwd" },
    });
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", { ...completedCommand, exit_code: 9 }),
      ),
    ).toMatchObject({ status: "error" });
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", {
          ...completedCommand,
          status: "failed",
          error: { message: "raw failure" },
        }),
      ),
    ).toMatchObject({ status: "error" });
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", {
          ...completedCommand,
          status: "declined",
        }),
      ),
    ).toMatchObject({ status: "cancelled" });

    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", {
          id: "read-1",
          type: "file_read",
          status: "completed",
          path: "/workspace/read.ts",
        }),
      ),
    ).toStrictEqual({
      kind: "standalone",
      action: "read",
      status: "success",
      summary: "Read /workspace/read.ts",
    });
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", {
          id: "write-1",
          type: "file_write",
          status: "failed",
          path: "/workspace/write.ts",
        }),
      ),
    ).toMatchObject({ action: "write", status: "error" });
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", {
          id: "edit-1",
          type: "file_edit",
          status: "declined",
          path: "/workspace/edit.ts",
        }),
      ),
    ).toMatchObject({ action: "edit", status: "cancelled" });
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", {
          id: "change-1",
          type: "file_change",
          status: "completed",
          changes: [
            { path: "/workspace/add.ts", kind: "add", diff: "raw diff" },
          ],
        }),
      ),
    ).toMatchObject({ action: "write", summary: "Wrote /workspace/add.ts" });
    expect(
      normalizeAgentToolEvent(
        codexItem("item.completed", {
          id: "change-1",
          type: "file_change",
          status: "completed",
          changes: [{ path: "/workspace/modify.ts", kind: "modify" }],
        }),
      ),
    ).toMatchObject({
      action: "edit",
      summary: "Edited /workspace/modify.ts",
    });

    for (const item of [
      {
        id: "delete",
        type: "file_change",
        status: "completed",
        changes: [{ path: "a", kind: "delete" }],
      },
      {
        id: "multi",
        type: "file_change",
        status: "completed",
        changes: [
          { path: "a", kind: "add" },
          { path: "b", kind: "modify" },
        ],
      },
      { id: "mcp", type: "mcp_tool_call", status: "completed", path: "a" },
      { id: "image", type: "image_view", status: "completed", path: "a" },
      {
        id: "malformed-command",
        type: "command_execution",
        status: "completed",
        command: "/bin/bash -lc 'unterminated",
        exit_code: 0,
      },
      { id: "unknown", type: "file_read", status: "in_progress", path: "a" },
    ]) {
      expect(
        normalizeAgentToolEvent(codexItem("item.completed", item)),
      ).toBeNull();
    }
  });
});

describe("tool event identity", () => {
  it("keeps transcript, tool row, and operation identities independent", () => {
    const transcriptId = assistantEventIdForRunEvent(RUN_ID, "event:4");
    const pendingRowId = toolEventIdForRunEvent(RUN_ID, "tool:event:4");
    const terminalRowId = toolEventIdForRunEvent(RUN_ID, "tool:event:5");
    const claudeOperationId = toolUseIdForProviderOperation(
      RUN_ID,
      "claude",
      "provider-operation-secret",
    );
    const codexOperationId = toolUseIdForProviderOperation(
      RUN_ID,
      "codex",
      "provider-operation-secret",
    );

    expect(transcriptId).toBe("ae848beb-761a-548f-8929-874f825c4b37");
    expect(pendingRowId).toBe("20054cbd-fac3-585a-8641-99a881e3900e");
    expect(terminalRowId).toBe("49421189-5dd4-5ae0-ac08-a0082d3d6054");
    expect(claudeOperationId).toBe("08d34bde-5278-578f-abe8-40db282e07e8");
    expect(codexOperationId).toBe("0e4b47d0-9cbc-5cc3-92f0-a104ff36c7ae");
    expect(toolUseIdForRunEvent(RUN_ID, "tool:event:4")).toBe(
      "b3becca3-07cc-5c26-ae7c-d11be4562765",
    );
    expect(assistantEventIdForRunEvent(RUN_ID, "event:4")).toBe(transcriptId);
    expect(toolEventIdForRunEvent(RUN_ID, "tool:event:4")).toBe(pendingRowId);
    expect(pendingRowId).not.toBe(terminalRowId);
    expect(pendingRowId).not.toBe(transcriptId);
    expect(claudeOperationId).not.toBe(codexOperationId);
    expect(claudeOperationId).not.toContain("provider-operation-secret");
    expect(toolUseIdForRunEvent(RUN_ID, "tool:event:4")).not.toBe(
      toolUseIdForRunEvent(RUN_ID, "tool:event:5"),
    );
  });
});
