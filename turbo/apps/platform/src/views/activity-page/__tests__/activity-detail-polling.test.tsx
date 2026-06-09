import { screen, waitFor } from "@testing-library/react";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import {
  zeroRunAgentEventsContract,
  zeroRunNetworkLogsContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
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
      browser_user_agent: false,
    },
  ];
}

describe("activity detail polling", () => {
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
  });
});
