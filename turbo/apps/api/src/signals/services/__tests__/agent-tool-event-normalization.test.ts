import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../lib/event-consumer/verify";
import { normalizeAgentToolEvent as normalizeProviderToolEvent } from "../agent-tool-event-normalization";
import {
  assistantEventIdForRunEvent,
  toolEventIdForRunEvent,
  toolUseIdForProviderOperation,
  toolUseIdForRunEvent,
} from "../assistant-event-id";

const RUN_ID = "8de6b4bf-d92a-4599-bde7-614e72552365";
const SANITIZED_LIVE_CODEX_COMMAND = String.raw`/bin/bash -lc "exec '/usr/local/bin/guest-tool-exec' --shell \""'$0" -c '"'printf codex-tool-v1'"`;
const SANITIZED_LIVE_CODEX_STARTED_EVENT = {
  type: "item.started",
  sequenceNumber: 5,
  item: {
    id: "exec-8993fae2-8f50-4963-989c-3489ab724f2e",
    type: "command_execution",
    status: "in_progress",
    command: SANITIZED_LIVE_CODEX_COMMAND,
  },
} satisfies AgentEvent;
const SANITIZED_LIVE_CODEX_COMPLETED_EVENT = {
  type: "item.completed",
  sequenceNumber: 6,
  item: {
    id: "exec-8993fae2-8f50-4963-989c-3489ab724f2e",
    type: "command_execution",
    status: "completed",
    command: SANITIZED_LIVE_CODEX_COMMAND,
    exit_code: 0,
  },
} satisfies AgentEvent;

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

function normalizeAgentToolEvent(event: AgentEvent) {
  const framework =
    event.type === "item.started" || event.type === "item.completed"
      ? "codex"
      : "claude-code";
  return normalizeProviderToolEvent(event, framework);
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
      summary: "Running printf '***'",
    });
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "Read",
          input: { file_path: " /workspace/a.ts " },
        }),
      ),
    ).toMatchObject({ action: "read", summary: "Reading /workspace/a.ts" });
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "Write",
          input: { file_path: "/workspace/b.ts" },
        }),
      ),
    ).toMatchObject({ action: "write", summary: "Writing /workspace/b.ts" });
    expect(
      normalizeAgentToolEvent(
        claudeToolUse({
          name: "Edit",
          input: { file_path: "/workspace/c.ts" },
        }),
      ),
    ).toMatchObject({ action: "edit", summary: "Editing /workspace/c.ts" });
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
      summary: "Editing /workspace/notebook.ipynb",
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
          summary: `Running printf '%s\\n' "$HOME"`,
        });
      }
    }
  });

  it("normalizes the sanitized live Codex managed wrapper lifecycle", () => {
    const started = normalizeAgentToolEvent(SANITIZED_LIVE_CODEX_STARTED_EVENT);
    expect(started).toStrictEqual({
      kind: "correlated",
      provider: "codex",
      providerOperationId: "exec-8993fae2-8f50-4963-989c-3489ab724f2e",
      action: "run",
      status: "pending",
      summary: "Running printf codex-tool-v1",
    });
    if (started?.kind !== "correlated") {
      throw new Error("Expected the live Codex start to normalize");
    }
    expect(started.summary.length).toBeLessThanOrEqual(240);
    expect(started.summary).not.toContain("guest-tool-exec");

    expect(
      normalizeAgentToolEvent({
        ...SANITIZED_LIVE_CODEX_COMPLETED_EVENT,
        item: {
          ...SANITIZED_LIVE_CODEX_COMPLETED_EVENT.item,
          aggregated_output: "CODEX_LIVE_OUTPUT_MUST_NOT_PERSIST",
          result: "CODEX_LIVE_RESULT_MUST_NOT_PERSIST",
        },
      }),
    ).toStrictEqual({
      kind: "correlated-terminal",
      provider: "codex",
      providerOperationId: "exec-8993fae2-8f50-4963-989c-3489ab724f2e",
      status: "success",
      standaloneOperation: {
        action: "run",
        summary: "Ran printf codex-tool-v1",
      },
    });
  });

  it("rejects malformed and ambiguous concatenated managed wrappers", () => {
    const malformedCommands = [
      SANITIZED_LIVE_CODEX_COMMAND.slice(0, -1),
      `${SANITIZED_LIVE_CODEX_COMMAND}""`,
      `${SANITIZED_LIVE_CODEX_COMMAND};true`,
      SANITIZED_LIVE_CODEX_COMMAND.replace(
        String.raw`'$0" -c '`,
        String.raw`'$1" -c '`,
      ),
      SANITIZED_LIVE_CODEX_COMMAND.replace(
        "printf codex-tool-v1",
        "printf $HOME",
      ),
      SANITIZED_LIVE_CODEX_COMMAND.replace(
        "printf codex-tool-v1",
        "printf `hostname`",
      ),
      SANITIZED_LIVE_CODEX_COMMAND.replace(
        "'printf codex-tool-v1'",
        "printf codex-tool-v1",
      ),
    ];

    for (const command of malformedCommands) {
      expect(
        normalizeAgentToolEvent(
          codexItem("item.started", {
            id: "malformed-live-wrapper",
            type: "command_execution",
            status: "in_progress",
            command,
          }),
        ),
      ).toBeNull();
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
      summary: `Reading ${"a".repeat(231)}…`,
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
        "Running printf '%s' \"exec '/usr/local/bin/guest-tool-exec' --shell\"",
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
      { id: " ", type: "file_read", status: "completed", path: "a" },
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

  it("dispatches provider adapters from the durable framework", () => {
    const piRead = claudeToolUse({
      name: "read",
      input: { path: "/workspace/pi.ts" },
    });
    const claudeRead = claudeToolUse({
      name: "Read",
      input: { file_path: "/workspace/claude.ts" },
    });
    const codexRead = codexItem("item.completed", {
      id: "codex-read",
      type: "file_read",
      status: "completed",
      path: "/workspace/codex.ts",
    });

    expect(normalizeProviderToolEvent(piRead, "pi")).toMatchObject({
      provider: "pi",
      action: "read",
    });
    expect(normalizeProviderToolEvent(piRead, "claude-code")).toBeNull();
    expect(normalizeProviderToolEvent(piRead, "codex")).toBeNull();
    expect(normalizeProviderToolEvent(piRead, null)).toBeNull();

    expect(normalizeProviderToolEvent(claudeRead, "claude-code")).toMatchObject(
      { provider: "claude", action: "read" },
    );
    expect(normalizeProviderToolEvent(claudeRead, "pi")).toBeNull();
    expect(normalizeProviderToolEvent(codexRead, "codex")).toMatchObject({
      action: "read",
    });
    expect(normalizeProviderToolEvent(codexRead, "claude-code")).toBeNull();

    const historicalBash = claudeToolUse({
      name: "bash",
      input: { command: "printf historical" },
    });
    expect(normalizeProviderToolEvent(historicalBash, null)).toMatchObject({
      provider: "claude",
      action: "run",
    });
  });

  it("maps exact Pi actions and structured terminal states", () => {
    const cases = [
      {
        name: "bash",
        input: { command: "  printf\tpi\n " },
        action: "run",
        summary: "Running printf pi",
      },
      {
        name: "read",
        input: { path: " /workspace/read.ts " },
        action: "read",
        summary: "Reading /workspace/read.ts",
      },
      {
        name: "write",
        input: { path: "/workspace/write.ts", content: "raw content" },
        action: "write",
        summary: "Writing /workspace/write.ts",
      },
      {
        name: "edit",
        input: { path: "/workspace/edit.ts", diff: "raw diff" },
        action: "edit",
        summary: "Editing /workspace/edit.ts",
      },
    ] as const;
    for (const fixture of cases) {
      expect(
        normalizeProviderToolEvent(
          claudeToolUse({ name: fixture.name, input: fixture.input }),
          "pi",
        ),
      ).toStrictEqual({
        kind: "correlated",
        provider: "pi",
        providerOperationId: "claude-operation-1",
        action: fixture.action,
        status: "pending",
        summary: fixture.summary,
      });
    }

    const result = (
      id: string,
      isError: unknown,
      cancelled: unknown = undefined,
    ) => {
      return agentEvent(2, {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              is_error: isError,
              vm0_user_cancelled: cancelled,
              content: "raw Pi result must not be projected",
              error: "raw Pi error must not be projected",
            },
          ],
        },
      });
    };
    expect(
      normalizeProviderToolEvent(result("success", false), "pi"),
    ).toStrictEqual({
      kind: "correlated-terminal",
      provider: "pi",
      providerOperationId: "success",
      status: "success",
    });
    expect(
      normalizeProviderToolEvent(result("error", true), "pi"),
    ).toStrictEqual({
      kind: "correlated-terminal",
      provider: "pi",
      providerOperationId: "error",
      status: "error",
    });
    expect(
      normalizeProviderToolEvent(result("cancelled", true, true), "pi"),
    ).toStrictEqual({
      kind: "correlated-terminal",
      provider: "pi",
      providerOperationId: "cancelled",
      status: "cancelled",
      requiresPendingOperation: true,
    });
  });

  it("fails closed for unsupported, malformed, and unsafe Pi records", () => {
    const malformedResults = [
      { tool_use_id: "missing-error" },
      { tool_use_id: "string-error", is_error: "false" },
      { tool_use_id: " ", is_error: false },
    ];
    const events = [
      claudeToolUse({ name: "Bash", input: { command: "pwd" } }),
      claudeToolUse({ name: "Read", input: { path: "/workspace/a" } }),
      claudeToolUse({ name: "read", input: { file_path: "/workspace/a" } }),
      claudeToolUse({ name: "read", input: { path: "   " } }),
      claudeToolUse({ name: "read", input: { path: "bad\0path" } }),
      claudeToolUse({
        name: "bash",
        input: { command: "/bin/bash -lc 'unterminated" },
      }),
      claudeToolUse({ name: "search", input: { query: "needle" } }),
      ...malformedResults.map((block) => {
        return agentEvent(2, {
          type: "user",
          message: { content: [{ type: "tool_result", ...block }] },
        });
      }),
      agentEvent(3, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "multi",
              name: "read",
              input: { path: "/workspace/a" },
            },
            { type: "text", text: "not canonical" },
          ],
        },
      }),
    ];
    for (const event of events) {
      expect(normalizeProviderToolEvent(event, "pi")).toBeNull();
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
    const piOperationId = toolUseIdForProviderOperation(
      RUN_ID,
      "pi",
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
    expect(piOperationId).not.toBe(claudeOperationId);
    expect(piOperationId).not.toBe(codexOperationId);
    expect(piOperationId).not.toContain("provider-operation-secret");
    expect(claudeOperationId).not.toContain("provider-operation-secret");
    expect(toolUseIdForRunEvent(RUN_ID, "tool:event:4")).not.toBe(
      toolUseIdForRunEvent(RUN_ID, "tool:event:5"),
    );
  });
});
