import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PREVIOUS_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { v5 as uuidv5 } from "uuid";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const ASSISTANT_EVENT_ID_NAMESPACE = "bfec4fb6-d5b8-43e4-a72a-9f58f87d7e01";
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
} as const;
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
} as const;

function assistantEventIdForRunEvent(
  runId: string,
  runEventId: string,
): string {
  return uuidv5(`${runId}:${runEventId}`, ASSISTANT_EVENT_ID_NAMESPACE);
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

function managedCommand(command: string): string {
  return `exec '/usr/local/bin/guest-tool-exec' --shell "$0" -c ${quoteShellArgumentForFixture(command)}`;
}

async function entitledToolRunActor(
  framework: "claude-code" | "codex" = "claude-code",
): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly api: ReturnType<typeof createRunsApi>;
}> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  if (framework === "claude-code") {
    await api.ensureOrgModelProvider(actor);
  } else {
    const { providerId } = await api.createOrgModelProvider(actor, {
      type: "openai-api-key",
      secret: "tool-materialization-openai-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
  }
  const agent = await bdd.createAgent(actor, {
    displayName: `Tool materialization ${randomUUID().slice(0, 8)}`,
    description: "Exercises append-only provider tool materialization.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, api };
}

async function sendChatRunMessage(
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const chat = createChatFilesBddApi(context);
  const sent = await chat.requestSendEvent(actor, { agentId, prompt }, [201]);
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected chat send to create a Run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function claimRun(
  api: ReturnType<typeof createRunsApi>,
  runId: string,
  runnerGroup: string,
) {
  await api.heartbeatRunner(runnerGroup);
  return await api.claimRunnerJob(runId);
}

describe("HOOK-02/CHAT-02: provider tool activity materialization", () => {
  it("uses the immutable false Run gate while preserving transcript identities", async () => {
    const chat = createChatFilesBddApi(context);
    const connectors = createConnectorBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup, api } = await entitledToolRunActor();

    const { runId, threadId } = await sendChatRunMessage(
      actor,
      agentId,
      "disabled tool activity",
    );
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatToolActivity]: true,
    });
    const claim = await claimRun(api, runId, runnerGroup);
    expect(claim.cliAgentType).toBe("claude-code");
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "claude-message-gate",
              content: [{ type: "text", text: "Gate-safe message" }],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "disabled-claude-tool",
                  name: "Bash",
                  input: { command: managedCommand("echo disabled") },
                },
              ],
            },
          },
          {
            type: "item.completed",
            sequenceNumber: 2,
            item: {
              id: "disabled-codex-thinking",
              type: "reasoning",
              text: "Gate-safe thinking",
            },
          },
          {
            type: "item.completed",
            sequenceNumber: 3,
            item: {
              id: "disabled-codex-tool",
              type: "command_execution",
              status: "completed",
              command: "pwd",
              exit_code: 0,
            },
          },
          SANITIZED_LIVE_CODEX_STARTED_EVENT,
          {
            ...SANITIZED_LIVE_CODEX_COMPLETED_EVENT,
            item: {
              ...SANITIZED_LIVE_CODEX_COMPLETED_EVENT.item,
              aggregated_output: "DISABLED_CODEX_OUTPUT_MUST_NOT_PERSIST",
              result: "DISABLED_CODEX_RESULT_MUST_NOT_PERSIST",
            },
          },
        ],
      },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const events = (await chat.listThreadEvents(actor, threadId)).events.filter(
      (event) => {
        return event.runId === runId;
      },
    );
    expect(
      events.filter((event) => {
        return event.eventType === "output.tool";
      }),
    ).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: assistantEventIdForRunEvent(runId, "event:0"),
        eventType: "output.message",
        content: "Gate-safe message",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        id: assistantEventIdForRunEvent(runId, "disabled-codex-thinking"),
        eventType: "output.thinking",
        thinking: "Gate-safe thinking",
      }),
    );

    await api.requestCancelRun(actor, runId, [200]);
  });

  it("persists progressive Claude starts and past-tense results across batches", async () => {
    const chat = createChatFilesBddApi(context);
    const connectors = createConnectorBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup, api } = await entitledToolRunActor();
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatToolActivity]: true,
    });
    const { runId, threadId } = await sendChatRunMessage(
      actor,
      agentId,
      "enabled Claude tool activity",
    );
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatToolActivity]: false,
    });
    const claim = await claimRun(api, runId, runnerGroup);
    expect(claim.cliAgentType).toBe("claude-code");
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const maskedCommand = managedCommand("printf '%s' '***'");
    const orderedBatch = [
      {
        type: "assistant",
        sequenceNumber: 2,
        message: { content: [{ type: "text", text: "text B" }] },
      },
      {
        type: "assistant",
        sequenceNumber: 0,
        message: { content: [{ type: "text", text: "text A" }] },
      },
      {
        type: "assistant",
        sequenceNumber: 1,
        message: {
          content: [
            {
              type: "tool_use",
              id: "claude-bash-provider-id",
              name: "Bash",
              input: {
                command: maskedCommand,
                description: "CLAUDE_CALL_INPUT_SECRET",
              },
            },
          ],
        },
      },
    ];

    context.mocks.ably.publish.mockClear();
    await webhooks.requestAgentEvents(
      { runId, events: orderedBatch },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);

    await webhooks.requestAgentEvents(
      { runId, events: orderedBatch },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);

    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "user",
            sequenceNumber: 3,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "claude-bash-provider-id",
                  is_error: false,
                  content: "CLAUDE_RESULT_SECRET",
                  error: "CLAUDE_RAW_ERROR",
                },
              ],
            },
          },
        ],
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);

    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 4,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "claude-read-provider-id",
                  name: "Read",
                  input: { file_path: "/workspace/***/read.ts" },
                },
              ],
            },
          },
        ],
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(3);

    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "user",
            sequenceNumber: 5,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "claude-read-provider-id",
                  is_error: true,
                  content: "CLAUDE_READ_RESULT_SECRET",
                },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 6,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "claude-write-provider-id",
                  name: "Write",
                  input: { file_path: "/workspace/write.ts" },
                },
              ],
            },
          },
          {
            type: "user",
            sequenceNumber: 7,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "claude-write-provider-id",
                  content: "CLAUDE_WRITE_CONTENT_SECRET",
                },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 8,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "claude-edit-provider-id",
                  name: "Edit",
                  input: { file_path: "/workspace/edit.ts" },
                },
              ],
            },
          },
          {
            type: "user",
            sequenceNumber: 9,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "claude-edit-provider-id",
                  content: "CLAUDE_EDIT_DIFF_SECRET",
                },
              ],
            },
          },
        ],
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(4);

    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 10,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "unsupported-search",
                  name: "Search",
                  input: { query: "unsupported" },
                },
              ],
            },
          },
          {
            type: "user",
            sequenceNumber: 11,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "orphan-provider-id",
                  content: "ORPHAN_RESULT_SECRET",
                },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 12,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "malformed-command",
                  name: "Bash",
                  input: { command: "/bin/bash -lc 'unterminated" },
                },
              ],
            },
          },
        ],
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(4);

    const redactedRows = await chat.listThreadEventRows(actor, threadId);
    expect(
      redactedRows.filter((row) => {
        return row.eventType === "output.tool";
      }),
    ).toHaveLength(0);

    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatToolActivity]: true,
    });
    const rows = await chat.listThreadEventRows(
      actor,
      threadId,
      undefined,
      PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
    );
    const toolRows = rows.filter((row) => {
      return row.eventType === "output.tool";
    });
    expect(toolRows).toHaveLength(8);
    expect(
      toolRows.map((row) => {
        return {
          sequenceNumber: row.runEventSequenceNumber,
          action: row.payload.action,
          status: row.payload.status,
          summary: row.payload.summary,
        };
      }),
    ).toStrictEqual([
      {
        sequenceNumber: 1,
        action: "run",
        status: "pending",
        summary: "Running printf '%s' '***'",
      },
      {
        sequenceNumber: 3,
        action: "run",
        status: "success",
        summary: "Ran printf '%s' '***'",
      },
      {
        sequenceNumber: 4,
        action: "read",
        status: "pending",
        summary: "Reading /workspace/***/read.ts",
      },
      {
        sequenceNumber: 5,
        action: "read",
        status: "error",
        summary: "Read /workspace/***/read.ts",
      },
      {
        sequenceNumber: 6,
        action: "write",
        status: "pending",
        summary: "Writing /workspace/write.ts",
      },
      {
        sequenceNumber: 7,
        action: "write",
        status: "success",
        summary: "Wrote /workspace/write.ts",
      },
      {
        sequenceNumber: 8,
        action: "edit",
        status: "pending",
        summary: "Editing /workspace/edit.ts",
      },
      {
        sequenceNumber: 9,
        action: "edit",
        status: "success",
        summary: "Edited /workspace/edit.ts",
      },
    ]);
    expect(toolRows[0]?.payload.toolUseId).toBe(toolRows[1]?.payload.toolUseId);
    expect(toolRows[2]?.payload.toolUseId).toBe(toolRows[3]?.payload.toolUseId);
    expect(
      new Set(
        toolRows.map((row) => {
          return row.id;
        }),
      ).size,
    ).toBe(8);
    for (const row of toolRows) {
      expect(Object.keys(row.payload).sort()).toStrictEqual([
        "action",
        "status",
        "summary",
        "toolUseId",
      ]);
      expect(row.runEventId).toBe(`tool:event:${row.runEventSequenceNumber}`);
    }

    const projected = (
      await chat.listThreadEvents(actor, threadId)
    ).events.filter((event) => {
      return (
        event.runId === runId &&
        (event.eventType === "output.message" ||
          event.eventType === "output.tool")
      );
    });
    expect(
      projected.slice(0, 3).map((event) => {
        return {
          type: event.eventType,
          sequenceNumber: event.sequenceNumber,
        };
      }),
    ).toStrictEqual([
      { type: "output.message", sequenceNumber: 0 },
      { type: "output.tool", sequenceNumber: 1 },
      { type: "output.message", sequenceNumber: 2 },
    ]);

    const projectedToolEvents = projected.filter((event) => {
      return event.eventType === "output.tool";
    });
    expect(projectedToolEvents).toHaveLength(8);
    const serializedRows = JSON.stringify({ toolRows, projectedToolEvents });
    for (const forbidden of [
      "claude-bash-provider-id",
      "claude-read-provider-id",
      "claude-write-provider-id",
      "claude-edit-provider-id",
      "CLAUDE_CALL_INPUT_SECRET",
      "CLAUDE_RESULT_SECRET",
      "CLAUDE_RAW_ERROR",
      "CLAUDE_READ_RESULT_SECRET",
      "CLAUDE_WRITE_CONTENT_SECRET",
      "CLAUDE_EDIT_DIFF_SECRET",
      "/usr/local/bin/guest-tool-exec",
    ]) {
      expect(serializedRows).not.toContain(forbidden);
    }

    await api.requestCancelRun(actor, runId, [200]);
  });

  it("materializes Codex command lifecycle and completed-only file snapshots idempotently", async () => {
    const chat = createChatFilesBddApi(context);
    const connectors = createConnectorBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup, api } =
      await entitledToolRunActor("codex");
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatToolActivity]: true,
    });
    const { runId, threadId } = await sendChatRunMessage(
      actor,
      agentId,
      "enabled Codex tool activity",
    );
    const claim = await claimRun(api, runId, runnerGroup);
    expect(claim.cliAgentType).toBe("codex");
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const wrapped = `/bin/bash -lc ${quoteDoubleShellArgumentForFixture(
      managedCommand("echo ***"),
    )}`;
    const batch = [
      {
        type: "item.completed",
        sequenceNumber: 1,
        item: {
          id: "codex-shared-command-provider-id",
          type: "command_execution",
          status: "completed",
          command: "echo TERMINAL_COMMAND_MUST_NOT_REPLACE_START",
          exit_code: 0,
          aggregated_output: "CODEX_STDOUT_SECRET",
        },
      },
      {
        type: "item.started",
        sequenceNumber: 0,
        item: {
          id: "codex-shared-command-provider-id",
          type: "command_execution",
          status: "in_progress",
          command: wrapped,
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 2,
        item: {
          id: "codex-failed-command-provider-id",
          type: "command_execution",
          status: "completed",
          command: "false",
          exit_code: 7,
          aggregated_output: "CODEX_STDERR_SECRET",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 3,
        item: {
          id: "codex-declined-command-provider-id",
          type: "command_execution",
          status: "declined",
          command: "dangerous-command",
          error: "CODEX_RAW_ERROR_SECRET",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 4,
        item: {
          id: "codex-message-before-live-command",
          type: "agent_message",
          text: "Before live Codex command",
        },
      },
      {
        ...SANITIZED_LIVE_CODEX_COMPLETED_EVENT,
        item: {
          ...SANITIZED_LIVE_CODEX_COMPLETED_EVENT.item,
          aggregated_output: "CODEX_LIVE_OUTPUT_MUST_NOT_PERSIST",
          result: "CODEX_LIVE_RESULT_MUST_NOT_PERSIST",
        },
      },
      SANITIZED_LIVE_CODEX_STARTED_EVENT,
      {
        type: "turn.completed",
        sequenceNumber: 7,
        turn: { status: "completed" },
      },
      {
        type: "item.completed",
        sequenceNumber: 8,
        item: {
          id: "codex-message-after-live-command",
          type: "agent_message",
          text: "After live Codex command",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 9,
        item: {
          id: "codex-file-read-provider-id",
          type: "file_read",
          status: "completed",
          path: "/workspace/***/read.txt",
          result: "CODEX_READ_RESULT_SECRET",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 10,
        item: {
          id: "codex-file-write-provider-id",
          type: "file_write",
          status: "failed",
          path: "/workspace/write.txt",
          content: "CODEX_FILE_CONTENT_SECRET",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 11,
        item: {
          id: "codex-file-edit-provider-id",
          type: "file_edit",
          status: "declined",
          path: "/workspace/edit.txt",
          diff: "CODEX_EDIT_DIFF_SECRET",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 12,
        item: {
          id: "codex-sibling-change-provider-id",
          type: "file_change",
          status: "completed",
          changes: [
            {
              path: "/workspace/added.txt",
              kind: "add",
              diff: "CODEX_ADD_DIFF_SECRET",
            },
          ],
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 13,
        item: {
          id: "codex-sibling-change-provider-id",
          type: "file_change",
          status: "completed",
          changes: [
            {
              path: "/workspace/modified.txt",
              kind: "modify",
              diff: "CODEX_MODIFY_DIFF_SECRET",
            },
          ],
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 14,
        item: {
          id: "codex-sibling-change-provider-id",
          type: "file_change",
          status: "completed",
          changes: [{ path: "/workspace/deleted.txt", kind: "delete" }],
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 15,
        item: {
          id: "codex-mcp-provider-id",
          type: "mcp_tool_call",
          status: "completed",
          path: "/workspace/ignored.txt",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 16,
        item: {
          id: "codex-malformed-wrapper-provider-id",
          type: "command_execution",
          status: "completed",
          command: "/bin/bash -c 'unterminated",
          exit_code: 0,
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 17,
        item: {
          id: "codex-image-provider-id",
          type: "image_view",
          status: "completed",
          path: "/workspace/ignored.png",
        },
      },
    ];

    context.mocks.ably.publish.mockClear();
    await webhooks.requestAgentEvents({ runId, events: batch }, headers, [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);

    context.mocks.ably.publish.mockClear();
    await webhooks.requestAgentEvents({ runId, events: batch }, headers, [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    const rows = await chat.listThreadEventRows(
      actor,
      threadId,
      undefined,
      PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
    );
    const toolRows = rows.filter((row) => {
      return row.eventType === "output.tool";
    });
    expect(toolRows).toHaveLength(11);
    expect(
      toolRows.map((row) => {
        return {
          sequenceNumber: row.runEventSequenceNumber,
          action: row.payload.action,
          status: row.payload.status,
          summary: row.payload.summary,
        };
      }),
    ).toStrictEqual([
      {
        sequenceNumber: 0,
        action: "run",
        status: "pending",
        summary: "Running echo ***",
      },
      {
        sequenceNumber: 1,
        action: "run",
        status: "success",
        summary: "Ran echo ***",
      },
      {
        sequenceNumber: 2,
        action: "run",
        status: "error",
        summary: "Ran false",
      },
      {
        sequenceNumber: 3,
        action: "run",
        status: "cancelled",
        summary: "Ran dangerous-command",
      },
      {
        sequenceNumber: 5,
        action: "run",
        status: "pending",
        summary: "Running printf codex-tool-v1",
      },
      {
        sequenceNumber: 6,
        action: "run",
        status: "success",
        summary: "Ran printf codex-tool-v1",
      },
      {
        sequenceNumber: 9,
        action: "read",
        status: "success",
        summary: "Read /workspace/***/read.txt",
      },
      {
        sequenceNumber: 10,
        action: "write",
        status: "error",
        summary: "Wrote /workspace/write.txt",
      },
      {
        sequenceNumber: 11,
        action: "edit",
        status: "cancelled",
        summary: "Edited /workspace/edit.txt",
      },
      {
        sequenceNumber: 12,
        action: "write",
        status: "success",
        summary: "Wrote /workspace/added.txt",
      },
      {
        sequenceNumber: 13,
        action: "edit",
        status: "success",
        summary: "Edited /workspace/modified.txt",
      },
    ]);
    expect(toolRows[0]?.payload.toolUseId).toBe(toolRows[1]?.payload.toolUseId);
    expect(toolRows[0]?.id).not.toBe(toolRows[1]?.id);
    expect(toolRows[4]?.payload.toolUseId).toBe(toolRows[5]?.payload.toolUseId);
    expect(toolRows[4]?.payload.toolUseId).not.toContain(
      "exec-8993fae2-8f50-4963-989c-3489ab724f2e",
    );
    expect(toolRows[4]?.id).not.toBe(toolRows[5]?.id);
    expect(toolRows[9]?.payload.toolUseId).not.toBe(
      toolRows[10]?.payload.toolUseId,
    );
    expect(
      new Set(
        toolRows.map((row) => {
          return row.id;
        }),
      ).size,
    ).toBe(11);
    expect(
      new Set(
        toolRows.map((row) => {
          return row.runEventId;
        }),
      ).size,
    ).toBe(11);
    for (const row of toolRows) {
      expect(Object.keys(row.payload).sort()).toStrictEqual([
        "action",
        "status",
        "summary",
        "toolUseId",
      ]);
    }

    const projected = (
      await chat.listThreadEvents(actor, threadId)
    ).events.filter((event) => {
      return (
        event.runId === runId &&
        (event.eventType === "output.message" ||
          event.eventType === "output.tool")
      );
    });
    expect(
      projected
        .filter((event) => {
          return (
            typeof event.sequenceNumber === "number" &&
            event.sequenceNumber >= 4 &&
            event.sequenceNumber <= 8
          );
        })
        .map((event) => {
          return {
            type: event.eventType,
            sequenceNumber: event.sequenceNumber,
          };
        }),
    ).toStrictEqual([
      { type: "output.message", sequenceNumber: 4 },
      { type: "output.tool", sequenceNumber: 5 },
      { type: "output.tool", sequenceNumber: 6 },
      { type: "output.message", sequenceNumber: 8 },
    ]);
    const projectedToolEvents = projected.filter((event) => {
      return event.eventType === "output.tool";
    });
    expect(projectedToolEvents).toHaveLength(11);
    const serializedRows = JSON.stringify({ toolRows, projectedToolEvents });
    for (const forbidden of [
      "codex-shared-command-provider-id",
      "exec-8993fae2-8f50-4963-989c-3489ab724f2e",
      "codex-sibling-change-provider-id",
      "TERMINAL_COMMAND_MUST_NOT_REPLACE_START",
      "CODEX_STDOUT_SECRET",
      "CODEX_STDERR_SECRET",
      "CODEX_RAW_ERROR_SECRET",
      "CODEX_LIVE_OUTPUT_MUST_NOT_PERSIST",
      "CODEX_LIVE_RESULT_MUST_NOT_PERSIST",
      "CODEX_READ_RESULT_SECRET",
      "CODEX_FILE_CONTENT_SECRET",
      "CODEX_EDIT_DIFF_SECRET",
      "CODEX_ADD_DIFF_SECRET",
      "CODEX_MODIFY_DIFF_SECRET",
      "/usr/local/bin/guest-tool-exec",
    ]) {
      expect(serializedRows).not.toContain(forbidden);
    }

    await api.requestCancelRun(actor, runId, [200]);
  });
});
