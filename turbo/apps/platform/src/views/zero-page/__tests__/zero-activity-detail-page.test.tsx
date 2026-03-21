import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function mockActivityDetailAPI() {
  const logDetail: LogDetail = {
    id: "run_1",
    sessionId: "session_1",
    agentName: "Test Agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    triggerSource: "web",
    status: "completed",
    prompt: "Hello, what can you do?",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
  };

  const eventsResponse: AgentEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: { message: { content: [{ type: "text", text: "Hi!" }] } },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };

  server.use(
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "run_1") {
        return HttpResponse.json(logDetail);
      }
      return new HttpResponse(null, { status: 404 });
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(eventsResponse);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("zeroActivityDetailPage", () => {
  it("should load detail when navigating directly to /activity/:runId", async () => {
    mockActivityDetailAPI();

    await setupPage({
      context,
      path: "/activity/run_1",
    });

    // The page should show the detail header card (not skeleton)
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Test Agent" }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Verify the header card rendered with run details
    expect(screen.getByText("9.0s")).toBeInTheDocument();
  }, 10_000);
});
