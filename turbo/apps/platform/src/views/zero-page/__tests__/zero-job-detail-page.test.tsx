import { describe, expect, it } from "vitest";
import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "mock-compose-id",
            name: "zero",
            displayName: null,
            description: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
            isOwner: true,
          },
          {
            id: "agent-detail-id",
            name: "my-agent",
            displayName: "My Agent",
            description: "A helpful agent",
            headVersionId: "version_2",
            updatedAt: "2024-01-02T00:00:00Z",
            isOwner: false,
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentComposeId: "agent-detail-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        connectors: [],
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ instructions: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [] });
    }),
  );
}

describe("zero job detail page", () => {
  it("should render agent detail with header and tabs", async () => {
    mockAPIs();
    await setupPage({ context, path: "/team/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("A helpful agent")).toBeInTheDocument();

    // All tabs should be visible
    expect(
      screen.getByRole("tab", { name: /Connectors/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Scheduled/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Profile/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Instructions/i }),
    ).toBeInTheDocument();
  });

  it("should switch to profile tab and show settings form", async () => {
    mockAPIs();
    await setupPage({ context, path: "/team/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    // Click Profile tab
    await act(() => {
      fireEvent.click(screen.getByRole("tab", { name: /Profile/i }));
    });

    // Profile tab should show settings form with agent name input
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
  });

  it("should show not-found error for unknown agent", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json({
          composes: [
            {
              id: "mock-compose-id",
              name: "zero",
              displayName: null,
              description: null,
              headVersionId: "version_1",
              updatedAt: "2024-01-01T00:00:00Z",
              isOwner: true,
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.get("*/api/zero/agents/:name", () => {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }),
    );

    await setupPage({ context, path: "/team/nonexistent" });

    await waitFor(() => {
      expect(screen.getByText("Agent not found")).toBeInTheDocument();
    });
  });

  it("should initialize tab from URL query parameter", async () => {
    mockAPIs();
    await setupPage({ context, path: "/team/my-agent?tab=profile" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    // Profile tab content should be visible (settings form with agent name input)
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
  });
});

function mockAPIsWithSchedules() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "mock-compose-id",
            name: "zero",
            displayName: null,
            description: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
            isOwner: true,
          },
          {
            id: "agent-detail-id",
            name: "my-agent",
            displayName: "My Agent",
            description: "A helpful agent",
            headVersionId: "version_2",
            updatedAt: "2024-01-02T00:00:00Z",
            isOwner: false,
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentComposeId: "agent-detail-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        connectors: [],
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ instructions: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({
        schedules: [
          {
            id: "sched-1",
            agentId: "agent-detail-id",
            agentName: "my-agent",
            orgSlug: "test",
            name: "morning-briefing",
            triggerType: "cron",
            cronExpression: "0 9 * * 1-5",
            atTime: null,
            intervalSeconds: null,
            timezone: "UTC",
            prompt: "Summarize yesterday's threads",
            description: null,
            enabled: true,
            notifyEmail: false,
            notifySlack: false,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: "2026-03-01T00:00:00Z",
            updatedAt: "2026-03-01T00:00:00Z",
          },
        ],
      });
    }),
  );
}

describe("zero job detail page - schedule card delete confirmation", () => {
  it("should show confirmation dialog when delete button is clicked in card view", async () => {
    mockAPIsWithSchedules();
    await setupPage({ context, path: "/team/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Delete Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Delete Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
    expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("should close dialog without deleting when Cancel is clicked in card view", async () => {
    let deleteCalled = false;

    mockAPIsWithSchedules();
    server.use(
      http.delete("*/api/zero/schedules/:name", () => {
        deleteCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({ context, path: "/team/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Delete Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Delete Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deleteCalled).toBeFalsy();
  });

  it("should call delete API when Delete is confirmed in card view", async () => {
    let deletedName: string | null = null;

    mockAPIsWithSchedules();
    server.use(
      http.delete("*/api/zero/schedules/:name", ({ params }) => {
        deletedName = params["name"] as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({ context, path: "/team/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Delete Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Delete Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deletedName).toBe("morning-briefing");
    });
  });
});
