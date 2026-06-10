import { screen, waitFor } from "@testing-library/react";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import {
  zeroRunAgentEventsContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
  zeroRunRunnerContract,
  type RunContextResponse,
} from "@vm0/api-contracts/contracts/zero-runs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogDetail,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function makeLogDetail(overrides: Partial<LogDetail>): LogDetail {
  return {
    id: "a0000000-0000-4000-a000-000000000099",
    sessionId: "session_new",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Agent One",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "running",
    prompt: "Hello",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: null,
    artifact: { name: null, version: null },
    ...overrides,
  };
}

function detailedActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "system",
      eventData: {
        subtype: "init",
        tools: ["Bash", "TodoWrite"],
        agents: ["checkout-auditor"],
        slash_commands: ["review"],
      },
      createdAt: "2026-03-10T14:56:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "text",
              text: "I will inspect the checkout failure.",
            },
            {
              type: "tool_use",
              id: "tool-bash-1",
              name: "Bash",
              input: { command: "pnpm test -- --filter checkout" },
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-bash-1",
              content: "checkout failure reproduced",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 1234, bytes: 512 },
      },
      createdAt: "2026-03-10T14:56:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-todo-1",
              name: "TodoWrite",
              input: {
                todos: [
                  {
                    content: "Reproduce checkout failure",
                    status: "completed",
                  },
                  { content: "Verify checkout retry", status: "in_progress" },
                ],
              },
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "system",
      eventData: {
        subtype: "task_started",
        task_id: "task-checkout",
        tool_use_id: "task-tool-1",
        description: "Audit checkout logs",
      },
      createdAt: "2026-03-10T14:56:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "assistant",
      eventData: {
        parent_tool_use_id: "task-tool-1",
        message: {
          content: [
            {
              type: "text",
              text: "The retry path drops the payment intent id.",
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "system",
      eventData: {
        subtype: "task_notification",
        task_id: "task-checkout",
        status: "completed",
        summary: "Audited checkout logs",
      },
      createdAt: "2026-03-10T14:56:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "result",
      eventData: {
        type: "result",
        is_error: false,
        result: "Checkout investigation complete.",
        num_turns: 3,
        duration_ms: 2000,
        modelUsage: {
          "claude-sonnet-4": {
            inputTokens: 1200,
            outputTokens: 340,
          },
        },
      },
      createdAt: "2026-03-10T14:56:08Z",
    },
  ];
}

function checkoutNetworkLogs(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-03-10T14:56:03.000Z",
      type: "http",
      action: "ALLOW",
      method: "POST",
      url: "https://payments.example.test/v1/checkout",
      status: 200,
      latency_ms: 245,
      request_size: 128,
      response_size: 512,
      firewall_name: "payments",
      firewall_permission: "checkout-write",
      firewall_rule_match: "POST /v1/checkout",
      firewall_params: { tenant: "acme" },
      firewall_billable: true,
      auth_resolved_secrets: ["PAYMENTS_API_KEY"],
      browser_user_agent: false,
      request_headers: {
        authorization: "Bearer sk_test",
        "content-type": "application/json",
      },
      request_body: '{"cartId":"cart_123","retry":true}',
      response_headers: {
        "content-type": "application/json",
      },
      response_body: "eyJzdGF0dXMiOiJvayJ9",
      response_body_encoding: "base64",
      response_body_truncated: true,
    },
  ];
}

function codexActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "thread.started",
      eventData: {
        type: "thread.started",
        thread_id: "codex-thread-1",
      },
      createdAt: "2026-03-10T15:00:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "turn.started",
      eventData: { type: "turn.started" },
      createdAt: "2026-03-10T15:00:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "msg-1",
          type: "agent_message",
          text: "I checked the billing worker retry path.",
        },
      },
      createdAt: "2026-03-10T15:00:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "Follow the failed retry through the logs.",
        },
      },
      createdAt: "2026-03-10T15:00:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "pnpm test --filter billing-worker",
        },
      },
      createdAt: "2026-03-10T15:00:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          exit_code: 1,
          aggregated_output:
            "billing worker failed\nstack line 1\nstack line 2\nstack line 3\nstack line 4",
        },
      },
      createdAt: "2026-03-10T15:00:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "read-1",
          type: "file_read",
          path: "src/billing/worker.ts",
        },
      },
      createdAt: "2026-03-10T15:00:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "read-1",
          type: "file_read",
          output: "export const worker = true;",
        },
      },
      createdAt: "2026-03-10T15:00:08Z",
    },
    {
      sequenceNumber: 8,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "edit-1",
          type: "file_edit",
          path: "src/billing/worker.ts",
        },
      },
      createdAt: "2026-03-10T15:00:09Z",
    },
    {
      sequenceNumber: 9,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "edit-1",
          type: "file_edit",
          diff: "- old retry\n+ new retry",
        },
      },
      createdAt: "2026-03-10T15:00:10Z",
    },
    {
      sequenceNumber: 10,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "files-1",
          type: "file_change",
          changes: [
            { kind: "modify", path: "src/billing/worker.ts" },
            { kind: "add", path: "src/billing/retry.test.ts" },
          ],
        },
      },
      createdAt: "2026-03-10T15:00:11Z",
    },
    {
      sequenceNumber: 11,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "unknown-1",
          type: "unknown_item",
          status: "completed",
          title: "Unknown codex item surfaced",
        },
      },
      createdAt: "2026-03-10T15:00:12Z",
    },
    {
      sequenceNumber: 12,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        usage: {
          input_tokens: 111,
          cached_input_tokens: 22,
          output_tokens: 33,
          reasoning_output_tokens: 4,
        },
      },
      createdAt: "2026-03-10T15:00:13Z",
    },
  ];
}

function codexRunContext(runId: string): RunContextResponse {
  return {
    prompt: "Repair the billing worker retry path",
    appendSystemPrompt: "Use Codex event logs when available",
    runId,
    sessionId: "codex-thread-1",
    secretNames: ["OPENAI_API_KEY"],
    vars: { CODEX_RETRY: "enabled" },
    environment: { NODE_ENV: "test" },
    firewalls: [
      {
        name: "openai",
        apis: [
          {
            base: "https://api.openai.test",
            permissions: [
              {
                name: "responses-write",
                description: "Create responses",
                rules: ["POST /v1/responses"],
              },
            ],
          },
        ],
      },
    ],
    networkPolicies: {
      openai: {
        allow: ["responses-write"],
        deny: ["metadata-access"],
        ask: [],
        unknownPolicy: "deny",
      },
    },
    volumes: [
      {
        name: "workspace",
        mountPath: "/workspace",
        vasStorageName: "codex-workspace-storage",
        vasVersionId: "workspace-version-1",
      },
    ],
    artifact: {
      mountPath: "/artifact",
      vasStorageName: "codex-artifact-storage",
      vasVersionId: "artifact-version-1",
    },
    featureFlags: { zeroDebug: true, codex: true },
  };
}

function codexNetworkFirstPage(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-03-10T15:00:14.000Z",
      type: "http",
      action: "ALLOW",
      method: "POST",
      url: "https://api.openai.test/v1/responses",
      status: 200,
      latency_ms: 320,
      request_size: 256,
      response_size: 1024,
      firewall_name: "openai",
      firewall_permission: "responses-write",
      firewall_rule_match: "POST /v1/responses",
      firewall_params: { model: "codex-mini" },
      firewall_billable: true,
      auth_resolved_secrets: ["OPENAI_API_KEY"],
    },
    {
      timestamp: "2026-03-10T15:00:15.000Z",
      type: "dns",
      action: "ALLOW",
      host: "api.openai.test",
      latency_ms: 5,
      dns_event: "query",
      dns_query_type: "A",
      dns_result: "203.0.113.10",
      dns_serial: "dns-1",
    },
  ];
}

function codexNetworkSecondPage(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-03-10T15:00:16.000Z",
      type: "http",
      action: "DENY",
      method: "GET",
      url: "http://metadata.google.internal/latest/meta-data",
      status: 403,
      latency_ms: 1000,
      firewall_error: "metadata access blocked",
    },
  ];
}

function getTabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!tab) {
    throw new Error(`Could not find tab: ${text}`);
  }
  return tab;
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Could not find button: ${text}`);
  }
  return button;
}

describe("activity detail polling", () => {
  it("shows recovery guidance for a failed activity", async () => {
    const runId = "a0000000-0000-4000-a000-000000000098";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Model Setup Run",
          status: "failed",
          error: "No model provider configured for this workspace",
          completedAt: "2026-03-10T14:56:03Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Model Setup Run" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByText("No model provider configured"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Configure a model provider to start running agents."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("$ zero model-provider set --help"),
    ).toBeInTheDocument();
  });

  it("renders events that arrive after an initially empty activity history", async () => {
    let eventsAvailable = false;
    let status: LogDetail["status"] = "running";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status }));
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        if (!eventsAvailable) {
          return respond(200, {
            events: [],
            hasMore: false,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        return respond(200, {
          events: [
            {
              sequenceNumber: 0,
              eventType: "assistant",
              eventData: {
                message: {
                  content: [{ type: "text", text: "Polled response arrived" }],
                },
              },
              createdAt: "2026-03-10T14:56:05Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Agent One" }),
      ).toBeInTheDocument();
    });

    const topic = "run:changed:a0000000-0000-4000-a000-000000000099";
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });

    status = "completed";
    eventsAvailable = true;
    context.mocks.ably.trigger(topic);

    await waitFor(() => {
      expect(screen.getByText("Polled response arrived")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });

  it("shows grouped steps search results and network logs for a completed activity", async () => {
    const runId = "a0000000-0000-4000-a000-000000000199";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Checkout Run",
          status: "completed",
          prompt: "Investigate checkout retries",
          appendSystemPrompt: "Use checkout specific diagnostics",
          startedAt: "2026-03-10T14:56:01Z",
          completedAt: "2026-03-10T14:56:10Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: detailedActivityEvents(),
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ respond }) => {
        return respond(200, {
          networkLogs: checkoutNetworkLogs(),
          hasMore: false,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Checkout Run" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("9.0s")).toBeInTheDocument();
    expect(
      screen.getAllByText("Use checkout specific diagnostics"),
    ).not.toHaveLength(0);
    expect(
      screen.getAllByText("Investigate checkout retries"),
    ).not.toHaveLength(0);
    expect(screen.getByText("Initialize")).toBeInTheDocument();
    expect(screen.getByText("2 tools")).toBeInTheDocument();
    expect(screen.getByText("1 agents")).toBeInTheDocument();
    expect(screen.getByText("1 commands")).toBeInTheDocument();
    expect(
      screen.getByText("I will inspect the checkout failure."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Bash")).not.toHaveLength(0);
    expect(
      screen.getAllByText("pnpm test -- --filter checkout"),
    ).not.toHaveLength(0);
    expect(screen.getAllByText("Verify checkout retry")).not.toHaveLength(0);
    expect(screen.getByText("[1/2]")).toBeInTheDocument();
    expect(screen.getByText("Audit checkout logs")).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(
      screen.getByText("Checkout investigation complete."),
    ).toBeInTheDocument();
    expect(screen.getByText("3 turns")).toBeInTheDocument();

    await fill(screen.getByPlaceholderText("Search steps"), "reproduced");

    await waitFor(() => {
      expect(
        screen.getByText(/\([0-9]+\/[0-9]+ matched\)/u),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText((_, element) => {
          return element?.textContent === "checkout failure reproduced";
        }),
      ).not.toHaveLength(0);
    });

    click(screen.getByText("Network"));

    await waitFor(() => {
      expect(
        screen.getByText("https://payments.example.test/v1/checkout"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("245ms")).toBeInTheDocument();
    expect(screen.getByText("payments")).toBeInTheDocument();

    click(screen.getByText("https://payments.example.test/v1/checkout"));

    await waitFor(() => {
      expect(screen.getByText("Rule Match")).toBeInTheDocument();
      expect(screen.getByText("POST /v1/checkout")).toBeInTheDocument();
      expect(screen.getByText("PAYMENTS_API_KEY")).toBeInTheDocument();
      expect(screen.getByText("Request Headers (2)")).toBeInTheDocument();
      expect(screen.getByText("Request Body")).toBeInTheDocument();
      expect(screen.getByText("Response Body")).toBeInTheDocument();
    });
    expect(
      screen.getByText('{"cartId":"cart_123","retry":true}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("[Binary data, 15B base64-encoded]"),
    ).toBeInTheDocument();
    expect(screen.getByText("truncated")).toBeInTheDocument();
  });

  it("shows codex run steps, debug context, runner reuse, and network paging", async () => {
    const runId = "a0000000-0000-4000-a000-000000000299";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Codex Billing Repair",
          framework: "codex",
          status: "completed",
          prompt: "Repair the billing worker retry path",
          appendSystemPrompt: "Use Codex event logs when available",
          startedAt: "2026-03-10T15:00:01Z",
          completedAt: "2026-03-10T15:00:18Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: codexActivityEvents(),
          hasMore: false,
          framework: "codex",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(zeroRunContextContract.getContext, ({ respond }) => {
      return respond(200, codexRunContext(runId));
    });
    context.mocks.api(zeroRunRunnerContract.getRunner, ({ respond }) => {
      return respond(200, { sandboxReuseResult: "reused" });
    });
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ query, respond }) => {
        if (query.since === undefined) {
          return respond(200, {
            networkLogs: codexNetworkFirstPage(),
            hasMore: true,
          });
        }

        return respond(200, {
          networkLogs: codexNetworkSecondPage(),
          hasMore: false,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Codex Billing Repair" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("17.0s")).toBeInTheDocument();
    expect(screen.getByText("Initialize")).toBeInTheDocument();
    expect(
      screen.getByText("I checked the billing worker retry path."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("[thinking] Follow the failed retry through the logs."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Bash")).not.toHaveLength(0);
    expect(
      screen.getAllByText("pnpm test --filter billing-worker"),
    ).not.toHaveLength(0);
    expect(screen.getByText("billing worker failed")).toBeInTheDocument();
    expect(screen.getAllByText("Read")).not.toHaveLength(0);
    expect(screen.getAllByText("Edit")).not.toHaveLength(0);
    expect(screen.getAllByText("src/billing/worker.ts")).not.toHaveLength(0);
    expect(screen.getByText("export const worker = true;")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName === "PRE" &&
          element?.textContent?.includes("- old retry") === true &&
          element.textContent.includes("+ new retry")
        );
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("add src/billing/retry.test.ts"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Codex unknown_item/u)).toBeInTheDocument();
    expect(screen.getByText("1 turns")).toBeInTheDocument();
    expect(screen.getByText("1 models")).toBeInTheDocument();

    await fill(
      screen.getByPlaceholderText("Search steps"),
      "billing worker failed",
    );

    await waitFor(() => {
      expect(
        screen.getByText(/\([0-9]+\/[0-9]+ matched\)/u),
      ).toBeInTheDocument();
      expect(screen.getAllByText("billing worker failed")).not.toHaveLength(0);
    });
    expect(screen.queryByText(/Codex unknown_item/u)).not.toBeInTheDocument();

    click(getTabByText("Context"));

    await waitFor(() => {
      expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();
    });
    expect(screen.getByText("CODEX_RETRY")).toBeInTheDocument();
    expect(screen.getByText("codex-workspace-storage")).toBeInTheDocument();
    expect(screen.getByText("codex-artifact-storage")).toBeInTheDocument();
    expect(
      screen.getAllByText((_, element) => {
        return (
          element?.tagName === "PRE" &&
          element.textContent?.includes("responses-write") === true
        );
      }),
    ).not.toHaveLength(0);

    click(getTabByText("Runner"));

    await waitFor(() => {
      expect(screen.getByText("Reused")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Sandbox was unparked from the idle pool."),
    ).toBeInTheDocument();

    click(getTabByText("Network"));

    await waitFor(() => {
      expect(
        screen.getByText("https://api.openai.test/v1/responses"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("320ms")).toBeInTheDocument();

    click(getButtonByText("Load more"));

    await waitFor(() => {
      expect(
        screen.getByText("http://metadata.google.internal/latest/meta-data"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("403")).toBeInTheDocument();
    expect(screen.getByText("1.0s")).toBeInTheDocument();
  });
});
