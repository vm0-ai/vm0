import { screen, waitFor } from "@testing-library/react";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEventsResponse,
  LogDetail,
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

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status: "completed" }));
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      async ({ query, respond }) => {
        if (query.since === undefined) {
          return respond(200, {
            events: [makeAssistantEvent(0, "Page one content")],
            hasMore: true,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        if (query.since === 0) {
          if (!secondPageStartedResolved) {
            secondPageStartedResolved = true;
            secondPageStarted.resolve();
          }
          await releaseSecondPage.promise;
          return respond(200, {
            events: [makeAssistantEvent(1, "Page two content")],
            hasMore: false,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    await secondPageStarted.promise;

    expect(screen.queryByText("Page one content")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Test Agent" }),
    ).not.toBeInTheDocument();

    releaseSecondPage.resolve();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Page one content")).toBeInTheDocument();
    expect(screen.getByText("Page two content")).toBeInTheDocument();
  });

  it("loads every paged event and reaches a completed state", async () => {
    let completed = false;

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          status: completed ? "completed" : "running",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ query, respond }) => {
        if (query.since === undefined) {
          return respond(200, {
            events: [makeAssistantEvent(0, "Page one content")],
            hasMore: true,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        completed = true;
        return respond(200, {
          events: [makeAssistantEvent(1, "Page two content")],
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
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Page one content")).toBeInTheDocument();
      expect(screen.getByText("Page two content")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });
});
