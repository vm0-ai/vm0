import { screen, waitFor } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEventsResponse,
  LogDetail,
} from "../../../signals/okou-page/log-types.ts";

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

function makeAssistantEvent(
  sequenceNumber: number,
  text: string,
): AgentEventsResponse["events"][number] {
  return {
    sequenceNumber,
    eventType: "assistant",
    eventData: {
      message: { content: [{ type: "text", text }] },
    },
    createdAt: "2026-03-10T14:56:02Z",
  };
}

describe("activity paged events", () => {
  it("waits for the complete initial event history before rendering timeline content", async () => {
    const secondPageStarted = context.mocks.deferred<void>();
    const releaseSecondPage = context.mocks.deferred<void>();
    let secondPageStartedResolved = false;

    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "completed" }));
    });
    context.mocks.api(
      runAgentEventsContract.getAgentEvents,
      async ({ query, respond }) => {
        if (query.cursor === undefined) {
          return respond(200, {
            events: [makeAssistantEvent(0, "Page one content")],
            hasMore: true,
            nextCursor: "second-page",
            status: "completed",
            lastEventSequence: 1,
          } satisfies AgentEventsResponse);
        }

        if (query.cursor === "second-page") {
          if (!secondPageStartedResolved) {
            secondPageStartedResolved = true;
            secondPageStarted.resolve();
          }
          await releaseSecondPage.promise;
          return respond(200, {
            events: [makeAssistantEvent(1, "Page two content")],
            hasMore: false,
            status: "completed",
            lastEventSequence: 1,
          } satisfies AgentEventsResponse);
        }

        return respond(200, {
          events: [],
          hasMore: false,
          status: "completed",
          lastEventSequence: null,
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    await secondPageStarted.promise;

    expect(screen.queryByText("Page one content")).not.toBeInTheDocument();
    await expect(
      screen.findByRole("heading", { name: "Test Agent" }),
    ).resolves.toBeInTheDocument();

    releaseSecondPage.resolve();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });
    expect(
      queryAllByRoleFast("tab").some((tab) => {
        return tab.textContent?.trim() === "Steps";
      }),
    ).toBeTruthy();
    expect(screen.getByText("Page one content")).toBeInTheDocument();
    expect(screen.getByText("Page two content")).toBeInTheDocument();
  });

  it("loads every paged event", async () => {
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "completed" }));
    });
    context.mocks.api(
      runAgentEventsContract.getAgentEvents,
      ({ query, respond }) => {
        if (query.cursor === undefined) {
          return respond(200, {
            events: [makeAssistantEvent(0, "Page one content")],
            hasMore: true,
            nextCursor: "second-page",
            status: "completed",
            lastEventSequence: 1,
          } satisfies AgentEventsResponse);
        }

        return respond(200, {
          events: [makeAssistantEvent(1, "Page two content")],
          hasMore: false,
          status: "completed",
          lastEventSequence: 1,
        } satisfies AgentEventsResponse);
      },
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
    await waitFor(() => {
      expect(screen.getByText("Page one content")).toBeInTheDocument();
      expect(screen.getByText("Page two content")).toBeInTheDocument();
    });
  });

  it("uses event pagination cursors returned by the server", async () => {
    const requests: {
      since: number | undefined;
      cursor: string | undefined;
    }[] = [];

    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "completed" }));
    });
    context.mocks.api(
      runAgentEventsContract.getAgentEvents,
      ({ query, respond }) => {
        requests.push({ since: query.since, cursor: query.cursor });
        if (query.cursor === "server-page-2") {
          return respond(200, {
            events: [makeAssistantEvent(1, "Second cursor page")],
            hasMore: false,
            status: "completed",
            lastEventSequence: 1,
          } satisfies AgentEventsResponse);
        }
        if (query.since !== undefined) {
          return respond(200, {
            events: [],
            hasMore: false,
            status: "completed",
            lastEventSequence: null,
          } satisfies AgentEventsResponse);
        }

        return respond(200, {
          events: [makeAssistantEvent(0, "First cursor page")],
          hasMore: true,
          nextCursor: "server-page-2",
          status: "completed",
          lastEventSequence: 1,
        } satisfies AgentEventsResponse);
      },
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
    expect(screen.getByText("First cursor page")).toBeInTheDocument();
    expect(screen.getByText("Second cursor page")).toBeInTheDocument();
    expect(requests.slice(0, 2)).toStrictEqual([
      { since: undefined, cursor: undefined },
      { since: undefined, cursor: "server-page-2" },
    ]);
  });

  it("polls until the terminal event watermark is visible and then stops", async () => {
    const finalEventRequestStarted = context.mocks.deferred<void>();
    let requestCount = 0;
    const requestedSequences: (number | undefined)[] = [];

    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "running" }));
    });
    context.mocks.api(
      runAgentEventsContract.getAgentEvents,
      ({ query, respond }) => {
        requestCount++;
        requestedSequences.push(query.since);
        if (requestCount === 1) {
          return respond(200, {
            events: [makeAssistantEvent(0, "Running event")],
            hasMore: false,
            status: "running",
            lastEventSequence: null,
          } satisfies AgentEventsResponse);
        }
        if (requestCount === 2) {
          return respond(200, {
            events: [],
            hasMore: false,
            status: "completed",
            lastEventSequence: 1,
          } satisfies AgentEventsResponse);
        }
        finalEventRequestStarted.resolve();
        return respond(200, {
          events: [makeAssistantEvent(1, "Final indexed event")],
          hasMore: false,
          status: "completed",
          lastEventSequence: 1,
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    await finalEventRequestStarted.promise;
    const finalEvent = await screen.findByText("Final indexed event");
    expect(finalEvent).toBeInTheDocument();
    expect(screen.getByText("Running event")).toBeInTheDocument();
    expect(requestCount).toBe(3);
    expect(requestedSequences).toStrictEqual([undefined, 0, 0]);
  });

  it("polls safely while waiting for the first indexed event", async () => {
    const indexedEventRequestStarted = context.mocks.deferred<void>();
    let requestCount = 0;
    const requestedSequences: (number | undefined)[] = [];

    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "running" }));
    });
    context.mocks.api(
      runAgentEventsContract.getAgentEvents,
      ({ query, respond }) => {
        requestCount++;
        requestedSequences.push(query.since);
        if (requestCount === 1) {
          return respond(200, {
            events: [],
            hasMore: false,
            status: "running",
            lastEventSequence: null,
          } satisfies AgentEventsResponse);
        }
        if (requestCount === 2) {
          indexedEventRequestStarted.resolve();
        }
        return respond(200, {
          events: [makeAssistantEvent(0, "First indexed event")],
          hasMore: false,
          status: "completed",
          lastEventSequence: 0,
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    await indexedEventRequestStarted.promise;
    await expect(
      screen.findByText("First indexed event"),
    ).resolves.toBeInTheDocument();
    expect(requestedSequences).toStrictEqual([undefined, undefined]);
  });

  it("stops polling a terminal run when an event gap never closes", async () => {
    let requestCount = 0;
    const requestedSequences: (number | undefined)[] = [];

    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "completed" }));
    });
    context.mocks.api(
      runAgentEventsContract.getAgentEvents,
      ({ query, respond }) => {
        requestCount++;
        requestedSequences.push(query.since);
        return respond(200, {
          events:
            query.since === undefined
              ? [makeAssistantEvent(0, "Only indexed event")]
              : [],
          hasMore: false,
          status: "completed",
          lastEventSequence: 2,
        } satisfies AgentEventsResponse);
      },
    );

    await setupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    expect(screen.getByText("Only indexed event")).toBeInTheDocument();
    expect(requestCount).toBe(31);
    expect(requestedSequences[0]).toBeUndefined();
    expect(
      requestedSequences.slice(1).every((sequence) => {
        return sequence === 0;
      }),
    ).toBeTruthy();
  });

  it("keeps activity details visible when event loading fails", async () => {
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "completed" }));
    });
    context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Event storage unavailable",
        },
      });
    });

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    await expect(
      screen.findByRole("heading", { name: "Test Agent" }),
    ).resolves.toBeInTheDocument();
    expect(
      queryAllByRoleFast("tab").map((tab) => {
        return tab.textContent?.trim();
      }),
    ).toStrictEqual(["Steps", "Context", "Runner", "Network"]);
  });

  it("starts a fresh event poller when navigating between activity runs", async () => {
    const firstRunId = "a0000000-0000-4000-a000-000000000099";
    const secondRunId = "a0000000-0000-4000-a000-000000000100";
    let secondRunRequestCount = 0;

    context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: params.id,
          displayName:
            params.id === firstRunId ? "First Agent" : "Second Agent",
          status: params.id === firstRunId ? "completed" : "running",
        }),
      );
    });
    context.mocks.api(
      runAgentEventsContract.getAgentEvents,
      ({ params, respond }) => {
        if (params.id === firstRunId) {
          return respond(200, {
            events: [makeAssistantEvent(0, "First run event")],
            hasMore: false,
            status: "completed",
            lastEventSequence: 0,
          } satisfies AgentEventsResponse);
        }

        secondRunRequestCount++;
        if (secondRunRequestCount < 3) {
          return respond(200, {
            events: [makeAssistantEvent(0, "Second run initial event")],
            hasMore: false,
            status: secondRunRequestCount === 1 ? "running" : "completed",
            lastEventSequence: secondRunRequestCount === 1 ? null : 1,
          } satisfies AgentEventsResponse);
        }
        return respond(200, {
          events: [
            makeAssistantEvent(0, "Second run initial event"),
            makeAssistantEvent(1, "Second run final event"),
          ],
          hasMore: false,
          status: "completed",
          lastEventSequence: 1,
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({ context, path: `/activities/${firstRunId}` });
    await screen.findByText("First run event");

    context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
      pathParams: { activityRunId: secondRunId },
    });

    await screen.findByText("Second run final event");
    expect(secondRunRequestCount).toBe(3);
  });
});
