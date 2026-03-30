import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function queueResponse(overrides?: {
  runningTasks?: unknown[];
  queue?: unknown[];
  estimatedTimePerRun?: number | null;
}) {
  return {
    concurrency: { tier: "free", limit: 2, active: 1, available: 1 },
    queue: overrides?.queue ?? [],
    runningTasks: overrides?.runningTasks ?? [],
    estimatedTimePerRun: overrides?.estimatedTimePerRun ?? null,
  };
}

describe("queue page", () => {
  it("should show cancel button for owner's running tasks", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId: "run-owner",
                agentName: "my-agent",
                agentDisplayName: "My Agent",
                userEmail: "me@test.com",
                startedAt: new Date().toISOString(),
                isOwner: true,
              },
            ],
          }),
        );
      }),
    );

    await setupPage({ context, path: "/queue" });

    await waitFor(() => {
      expect(screen.getByText("My Agent")).toBeInTheDocument();
    });

    // Owner should see the Cancel button
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    expect(cancelButtons).toHaveLength(1);
  });

  it("should not show cancel button for non-owner running tasks", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId: "run-other",
                agentName: "other-agent",
                agentDisplayName: "Other Agent",
                userEmail: "other@test.com",
                startedAt: new Date().toISOString(),
                isOwner: false,
              },
            ],
          }),
        );
      }),
    );

    await setupPage({ context, path: "/queue" });

    await waitFor(() => {
      expect(screen.getByText("Other Agent")).toBeInTheDocument();
    });

    // Non-owner should NOT see a Cancel button
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("should show cancel button for owner's queued entries", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: [
              {
                position: 1,
                agentName: "queued-agent",
                agentDisplayName: "Queued Agent",
                userEmail: "me@test.com",
                createdAt: new Date().toISOString(),
                isOwner: true,
                runId: "run-queued",
                prompt: null,
                triggerSource: null,
                sessionLink: null,
              },
            ],
          }),
        );
      }),
    );

    await setupPage({ context, path: "/queue" });

    await waitFor(() => {
      expect(screen.getByText("Queued Agent")).toBeInTheDocument();
    });

    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    expect(cancelButtons).toHaveLength(1);
  });

  it("should not show cancel button when runId is null", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId: null,
                agentName: "starting-agent",
                agentDisplayName: "Starting Agent",
                userEmail: "me@test.com",
                startedAt: null,
                isOwner: true,
              },
            ],
          }),
        );
      }),
    );

    await setupPage({ context, path: "/queue" });

    await waitFor(() => {
      expect(screen.getByText("Starting Agent")).toBeInTheDocument();
    });

    // No cancel button when runId is null, even for owner
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("should call cancel endpoint when cancel button is clicked", async () => {
    let cancelledRunId: string | null = null;

    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId: "run-to-cancel",
                agentName: "cancel-test-agent",
                agentDisplayName: "Cancel Test Agent",
                userEmail: "me@test.com",
                startedAt: new Date().toISOString(),
                isOwner: true,
              },
            ],
          }),
        );
      }),
      http.post("*/api/zero/runs/:runId/cancel", ({ params }) => {
        cancelledRunId = params.runId as string;
        return HttpResponse.json({
          id: params.runId,
          status: "cancelled",
          message: "Run cancelled",
        });
      }),
    );

    await setupPage({ context, path: "/queue" });

    await waitFor(() => {
      expect(screen.getByText("Cancel Test Agent")).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    cancelButton.click();

    await waitFor(() => {
      expect(cancelledRunId).toBe("run-to-cancel");
    });
  });
});
