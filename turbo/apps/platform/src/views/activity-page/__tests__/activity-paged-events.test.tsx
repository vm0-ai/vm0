import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  logsListContract,
  logsByIdContract,
} from "@vm0/api-contracts/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function makeLogDetail(overrides: Partial<LogDetail>): LogDetail {
  return {
    id: "a0000000-0000-4000-a000-000000000099",
    sessionId: "session_test",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web" as const,
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

    setMockComposesList([]);
    server.use(
      mockApi(logsByIdContract.getById, ({ respond }) => {
        return respond(
          200,
          makeLogDetail({
            status: eventFetchCount < 2 ? "running" : "completed",
          }),
        );
      }),
      mockApi(
        zeroRunAgentEventsContract.getAgentEvents,
        ({ query, respond }) => {
          eventFetchCount++;
          const since = query.since;

          // First page: has more events
          if (since === undefined) {
            return respond(200, {
              events: [page1Event],
              hasMore: true,
              framework: "claude-code",
            } satisfies AgentEventsResponse);
          }

          // Second page: no more events
          return respond(200, {
            events: [page2Event],
            hasMore: false,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        },
      ),
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

    // Polling loop auto-iterates in VITEST (setLoop yields via setTimeout(0))
    // and eventually re-checks status, picking up the "completed" transition.
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });

  it("should stop polling when navigating away from the run page", async () => {
    let eventFetchCount = 0;

    setMockComposesList([]);
    server.use(
      mockApi(logsListContract.list, ({ respond }) => {
        return respond(200, {
          data: [
            {
              id: "a0000000-0000-4000-a000-000000000099",
              sessionId: "session_test",
              agentId: "e0000000-0000-4000-a000-000000000010",
              displayName: "Test Agent",
              framework: "claude-code",
              status: "running",
              triggerSource: "web" as const,
              triggerAgentName: null,
              scheduleId: null,
              prompt: "Test prompt",
              createdAt: "2026-03-10T14:56:00Z",
              startedAt: "2026-03-10T14:56:01Z",
              completedAt: null,
            },
          ],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters: { statuses: [], sources: [], agents: [] },
        });
      }),
      mockApi(logsByIdContract.getById, ({ respond }) => {
        return respond(200, makeLogDetail({ status: "running" }));
      }),
      mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
        eventFetchCount++;
        return respond(200, {
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

    // Start on the list page so setup can complete while the run is still
    // "running" (polling on the detail page would loop forever).
    // Enable ZeroDebug so the breadcrumb link back to /activities is rendered.
    detachedSetupPage({
      context,
      path: "/activities",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Navigate to the detail page
    const row = screen.getByText("Test Agent").closest("a");
    expect(row).not.toBeNull();
    click(row!);

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
    click(breadcrumb!);

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
