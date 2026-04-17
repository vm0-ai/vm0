import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import type {
  LogDetail,
  AgentEventsResponse,
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

describe("activity detail polling with initially empty events", () => {
  it("should pick up events that appear after the initial empty fetch", async () => {
    let eventFetchCount = 0;

    server.use(
      http.get("*/api/zero/composes/list", () => {
        return HttpResponse.json({ composes: [] });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.get("*/api/zero/logs/:id", () => {
        return HttpResponse.json(
          makeLogDetail({
            // Stay "running" so polling continues
            status: eventFetchCount < 3 ? "running" : "completed",
          }),
        );
      }),
      http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
        eventFetchCount++;

        // First 2 fetches return empty events (run just started)
        if (eventFetchCount <= 2) {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        // Subsequent fetches return actual events
        return HttpResponse.json({
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

    // Drive the Ably-based polling loop. Each triggerAblyEvent unblocks the
    // deferred promise inside setAblyLoop$. We must wait for the loop body
    // to finish (which creates a new deferred) before firing the next event.
    const topic = "thread:a0000000-0000-4000-a000-000000000099";

    triggerAblyEvent(topic);
    await waitFor(() => {
      expect(eventFetchCount).toBeGreaterThanOrEqual(2);
    });

    triggerAblyEvent(topic);
    await waitFor(() => {
      expect(eventFetchCount).toBeGreaterThanOrEqual(3);
    });

    // Wait for polling to pick up the events
    await waitFor(() => {
      expect(screen.getByText("Polled response arrived")).toBeInTheDocument();
    });

    // Confirm the telemetry endpoint was called multiple times (re-fetched after empty)
    expect(eventFetchCount).toBeGreaterThanOrEqual(3);

    // Trigger one more event to let the loop detect terminal status
    triggerAblyEvent(topic);
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });
});
