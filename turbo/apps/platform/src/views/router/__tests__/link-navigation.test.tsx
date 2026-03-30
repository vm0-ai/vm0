import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockQueuePage() {
  server.use(
    http.get("*/api/zero/runs/queue", () => {
      return HttpResponse.json({
        concurrency: { tier: "free", limit: 2, active: 1, available: 1 },
        runningTasks: [
          {
            runId: "run_link_1",
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

describe("link component new-tab behavior", () => {
  it("should open new tab on ctrl+click instead of navigating via pushState", async () => {
    mockQueuePage();

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    await setupPage({ context, path: "/queue" });

    await waitFor(() => {
      expect(screen.getByText("Link Agent")).toBeInTheDocument();
    });

    // The "View logs" link is a Link component — ctrl+click should open new tab
    const viewLogsLink = screen.getByText("View logs");
    fireEvent.click(viewLogsLink, { ctrlKey: true });

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/activity/run_link_1"),
        "_blank",
      );
    });

    openSpy.mockRestore();
  }, 15_000);
});
