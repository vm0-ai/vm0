/**
 * Navigation tests for Link component (views/router/link.tsx).
 * Tests href computation, children rendering, and click behavior.
 * Uses the queue page (/queues) as a host, which renders:
 *   <Link pathname="/activities/:id" options={{ pathParams: { id: runId } }}>
 *     View logs
 *   </Link>
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const RUN_ID = "b0000000-0000-4000-b000-000000000001";
const EXPECTED_HREF = `/activities/${RUN_ID}`;

function mockQueuePage() {
  server.use(
    http.get("*/api/zero/runs/queue", () => {
      return HttpResponse.json({
        concurrency: { tier: "free", limit: 2, active: 1, available: 1 },
        runningTasks: [
          {
            runId: RUN_ID,
            agentName: "link-agent",
            agentDisplayName: "Link Agent",
            userEmail: "me@test.com",
            startedAt: new Date().toISOString(),
            isOwner: true,
          },
        ],
        queue: [],
        estimatedTimePerRun: null,
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockActivityDetailPage() {
  const logDetail: LogDetail = {
    id: RUN_ID,
    sessionId: null,
    agentId: "link-agent",
    displayName: "Link Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:01Z",
    completedAt: "2026-01-01T00:00:02Z",
    artifact: { name: null, version: null },
  };

  const eventsResponse: AgentEventsResponse = {
    events: [],
    hasMore: false,
    framework: "claude-code",
  };

  server.use(
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({ composes: [] });
    }),
    http.get("*/api/zero/logs/:id", () => {
      return HttpResponse.json(logDetail);
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(eventsResponse);
    }),
  );
}

describe("link component", () => {
  it("computed href attribute renders correctly (INFRA-D-010)", async () => {
    mockQueuePage();
    await setupPage({ context, path: "/queues" });

    const link = await waitFor(() => {
      return screen.getByText("View logs");
    });

    expect(link).toHaveAttribute("href", EXPECTED_HREF);
  });

  it("click navigates via custom handler (INFRA-D-012)", async () => {
    mockQueuePage();
    mockActivityDetailPage();

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    await setupPage({ context, path: "/queues" });

    const link = await waitFor(() => {
      return screen.getByText("View logs");
    });

    const user = userEvent.setup();
    await user.click(link);

    // Wait for the activity detail page to fully initialize so there is no
    // pending async work when the test ends (which would cause an unhandled
    // rejection from route.ts).
    await waitFor(() => {
      expect(pathname()).toBe(EXPECTED_HREF);
      expect(
        screen.getByRole("heading", { name: "Link Agent" }),
      ).toBeInTheDocument();
    });

    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it("modifier click opens new tab (INFRA-D-013)", async () => {
    mockQueuePage();

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    try {
      await setupPage({ context, path: "/queues" });

      const link = await waitFor(() => {
        return screen.getByText("View logs");
      });

      const user = userEvent.setup();

      // meta click
      await user.keyboard("{Meta>}");
      await user.click(link);
      await user.keyboard("{/Meta}");

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith(
          expect.stringContaining(EXPECTED_HREF),
          "_blank",
        );
      });

      openSpy.mockClear();

      // ctrl click
      await user.keyboard("{Control>}");
      await user.click(link);
      await user.keyboard("{/Control}");

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith(
          expect.stringContaining(EXPECTED_HREF),
          "_blank",
        );
      });

      openSpy.mockClear();

      // shift click
      await user.keyboard("{Shift>}");
      await user.click(link);
      await user.keyboard("{/Shift}");

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith(
          expect.stringContaining(EXPECTED_HREF),
          "_blank",
        );
      });
    } finally {
      openSpy.mockRestore();
    }
  });
});
