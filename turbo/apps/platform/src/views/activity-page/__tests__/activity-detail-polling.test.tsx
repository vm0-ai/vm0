import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

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

describe("activity detail polling with initially empty events", () => {
  it("should pick up events that appear after the initial empty fetch", async () => {
    let eventFetchCount = 0;

    setMockComposesList([]);
    server.use(
      mockApi(logsByIdContract.getById, ({ respond }) => {
        return respond(
          200,
          makeLogDetail({
            // Stay "running" so polling continues
            status: eventFetchCount < 3 ? "running" : "completed",
          }),
        );
      }),
      mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
        eventFetchCount++;

        // First 2 fetches return empty events (run just started)
        if (eventFetchCount <= 2) {
          return respond(200, {
            events: [],
            hasMore: false,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        // Subsequent fetches return actual events
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
      }),
    );

    // Navigate directly to a fresh run's detail page
    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    // Wait for the detail heading to appear
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Agent One" }),
      ).toBeInTheDocument();
    });

    // The polling loop auto-iterates (setLoop yields via setTimeout(0) in
    // VITEST, so each iteration runs as fast as React can flush). Wait for
    // the events to arrive naturally.
    await waitFor(() => {
      expect(screen.getByText("Polled response arrived")).toBeInTheDocument();
    });

    // Confirm the telemetry endpoint was called multiple times (re-fetched after empty)
    expect(eventFetchCount).toBeGreaterThanOrEqual(3);

    // And the loop eventually detects terminal status.
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });
});
