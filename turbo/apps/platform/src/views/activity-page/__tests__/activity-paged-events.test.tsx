import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function makeLogDetail(overrides: Partial<LogDetail>): LogDetail {
  return {
    id: "a0000000-0000-4000-a000-000000000099",
    sessionId: "session_test",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Test Agent",
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

describe("activity paged events", () => {
  it("should load multi-page events when hasMore is true then false", async () => {
    let eventFetchCount = 0;

    const page1Event = {
      sequenceNumber: 0,
      eventType: "assistant",
      eventData: {
        message: { content: [{ type: "text", text: "Page one content" }] },
      },
      createdAt: "2026-03-10T14:56:02Z",
    };

    const page2Event = {
      sequenceNumber: 1,
      eventType: "assistant",
      eventData: {
        message: { content: [{ type: "text", text: "Page two content" }] },
      },
      createdAt: "2026-03-10T14:56:10Z",
    };

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
            status: eventFetchCount < 2 ? "running" : "completed",
          }),
        );
      }),
      http.get("*/api/zero/runs/:runId/telemetry/agent", ({ request }) => {
        eventFetchCount++;
        const url = new URL(request.url);
        const since = url.searchParams.get("since");

        // First page: has more events
        if (!since) {
          return HttpResponse.json({
            events: [page1Event],
            hasMore: true,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        // Second page: no more events
        return HttpResponse.json({
          events: [page2Event],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      }),
    );

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Both pages of events should eventually be rendered
    await waitFor(() => {
      expect(screen.getByText("Page one content")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Page two content")).toBeInTheDocument();
    });

    // Confirm pagination was exercised (at least 2 event fetches)
    expect(eventFetchCount).toBeGreaterThanOrEqual(2);

    // Wait for completion
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });

  it("should stop polling when navigating away from the run page", async () => {
    let eventFetchCount = 0;

    server.use(
      http.get("*/api/zero/composes/list", () => {
        return HttpResponse.json({ composes: [] });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.get("*/api/zero/logs", () => {
        return HttpResponse.json({
          data: [
            {
              id: "a0000000-0000-4000-a000-000000000099",
              sessionId: "session_test",
              agentId: "e0000000-0000-4000-a000-000000000010",
              displayName: "Test Agent",
              orgSlug: "test",
              framework: "claude-code",
              status: "running",
              triggerSource: "web",
              triggerAgentName: null,
              scheduleId: null,
              createdAt: "2026-03-10T14:56:00Z",
              startedAt: "2026-03-10T14:56:01Z",
              completedAt: null,
            },
          ],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters: { statuses: [], sources: [], agents: [] },
        });
      }),
      http.get("*/api/zero/logs/:id", () => {
        return HttpResponse.json(makeLogDetail({ status: "running" }));
      }),
      http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
        eventFetchCount++;
        return HttpResponse.json({
          events: [
            {
              sequenceNumber: 0,
              eventType: "assistant",
              eventData: {
                message: {
                  content: [{ type: "text", text: "Running event" }],
                },
              },
              createdAt: "2026-03-10T14:56:02Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      }),
    );

    const user = userEvent.setup();

    // Start on the list page so setup can complete while the run is still
    // "running" (polling on the detail page would loop forever).
    // Enable ActivityLogList so the breadcrumb link back to /activities is rendered.
    detachedSetupPage({
      context,
      path: "/activities",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Navigate to the detail page
    const row = screen.getByText("Test Agent").closest("a");
    expect(row).not.toBeNull();
    await user.click(row!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Running event")).toBeInTheDocument();
    });

    // Record fetch count before navigating away
    const fetchCountBeforeNav = eventFetchCount;

    // Navigate away using the breadcrumb link
    const breadcrumb = screen.getByText("Activity").closest("a");
    expect(breadcrumb).not.toBeNull();
    await user.click(breadcrumb!);

    // Activity list heading should appear
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Activity" }),
      ).toBeInTheDocument();
    });

    // After navigating away, polling should have stopped. Allow up to 2 extra
    // fetches for any request already in-flight at navigation time, but confirm
    // the loop does not continue to run indefinitely.
    const fetchCountAfterNav = eventFetchCount;
    expect(fetchCountAfterNav - fetchCountBeforeNav).toBeLessThanOrEqual(2);
  });
});
