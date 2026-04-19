import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-detail-id",
          name: "my-agent",
          displayName: "My Agent",
          description: "A helpful agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        connectors: [],
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [] });
    }),
  );
}

describe("zero job detail page", () => {
  it("should render agent detail with header and tabs", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("A helpful agent")).toBeInTheDocument();

    // All tabs should be visible
    const tabs = screen.getAllByRole("tab");
    expect(
      tabs.some((el) => {
        return /Authorization/i.test(el.textContent ?? "");
      }),
    ).toBeTruthy();
    expect(
      tabs.some((el) => {
        return /Scheduled/i.test(el.textContent ?? "");
      }),
    ).toBeTruthy();
    expect(
      tabs.some((el) => {
        return /Profile/i.test(el.textContent ?? "");
      }),
    ).toBeTruthy();
    expect(
      tabs.some((el) => {
        return /Instructions/i.test(el.textContent ?? "");
      }),
    ).toBeTruthy();
  });

  it("should switch to profile tab and show settings form", async () => {
    const user = userEvent.setup();
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    // Click Profile tab
    const profileTab = screen.getAllByRole("tab").find((el) => {
      return /Profile/i.test(el.textContent ?? "");
    });
    expect(profileTab).toBeDefined();
    await user.click(profileTab!);

    // Profile tab should show settings form with agent name input
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
  });

  it("should show not-found error for unknown agent", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          {
            id: "c0000000-0000-4000-a000-000000000001",
            name: "zero",
            displayName: null,
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ]);
      }),
      http.get("*/api/zero/agents/:name", () => {
        return HttpResponse.json(
          { error: { message: "Not found", code: "INTERNAL_SERVER_ERROR" } },
          { status: 404 },
        );
      }),
    );

    detachedSetupPage({ context, path: "/agents/nonexistent" });

    await waitFor(() => {
      expect(screen.getByText("Agent not found")).toBeInTheDocument();
    });
  });

  it("should initialize tab from URL query parameter", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent?tab=profile" });

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
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-detail-id",
          name: "my-agent",
          displayName: "My Agent",
          description: "A helpful agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        connectors: [],
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({
        schedules: [
          {
            id: "f0000002-0000-4000-a000-000000000001",
            agentId: "e0000000-0000-4000-a000-000000000010",
            displayName: null,
            name: "morning-briefing",
            triggerType: "cron",
            cronExpression: "0 9 * * 1-5",
            atTime: null,
            intervalSeconds: null,
            timezone: "UTC",
            prompt: "Summarize yesterday's threads",
            description: null,
            enabled: true,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: "2026-03-01T00:00:00Z",
            updatedAt: "2026-03-01T00:00:00Z",
            userId: "test-user-123",
            appendSystemPrompt: null,
            vars: null,
            secretNames: null,
            artifactName: null,
            artifactVersion: null,
            volumeVersions: null,
            retryStartedAt: null,
            consecutiveFailures: 0,
          },
        ],
      });
    }),
  );
}

async function openScheduleMenuAndClick(
  user: ReturnType<typeof userEvent.setup>,
  timeLabel: string,
  action: "Edit" | "Delete" | "Run now",
) {
  const menuTrigger = screen.getAllByLabelText(
    `More actions for ${timeLabel}`,
  )[0];
  await user.click(menuTrigger);
  await waitFor(() => {
    expect(screen.getByText(action)).toBeInTheDocument();
  });
  await user.click(screen.getByText(action));
}

describe("zero job detail page - schedule card delete confirmation", () => {
  it("should show confirmation dialog when delete button is clicked in card view", async () => {
    const user = userEvent.setup();
    mockAPIsWithSchedules();
    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openScheduleMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
    expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("should close dialog without deleting when Cancel is clicked in card view", async () => {
    const user = userEvent.setup();
    let deleteCalled = false;

    mockAPIsWithSchedules();
    server.use(
      http.delete("*/api/zero/schedules/:name", () => {
        deleteCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openScheduleMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deleteCalled).toBeFalsy();
  });

  it("should call delete API when Delete is confirmed in card view", async () => {
    const user = userEvent.setup();
    let deletedName: string | null = null;

    mockAPIsWithSchedules();
    server.use(
      http.delete("*/api/zero/schedules/:name", ({ params }) => {
        deletedName = params["name"] as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openScheduleMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(deletedName).toBe("morning-briefing");
    });
  });
});

describe("zero job detail page - schedule tab toggle", () => {
  it("should not flash empty state when toggling schedule status", async () => {
    const user = userEvent.setup();
    mockAPIsWithSchedules();

    server.use(
      http.post("*/api/zero/schedules/:name/:action", () => {
        return HttpResponse.json({
          id: "f0000002-0000-4000-a000-000000000001",
          agentId: "e0000000-0000-4000-a000-000000000010",
          displayName: null,
          name: "morning-briefing",
          triggerType: "cron",
          cronExpression: "0 9 * * 1-5",
          atTime: null,
          intervalSeconds: null,
          timezone: "UTC",
          prompt: "Summarize yesterday's threads",
          description: null,
          enabled: false,
          nextRunAt: null,
          lastRunAt: null,
          createdAt: "2026-03-01T00:00:00Z",
          updatedAt: "2026-03-01T00:00:00Z",
          userId: "test-user-123",
          appendSystemPrompt: null,
          vars: null,
          secretNames: null,
          artifactName: null,
          artifactVersion: null,
          volumeVersions: null,
          retryStartedAt: null,
          consecutiveFailures: 0,
        });
      }),
    );

    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    // Toggle the schedule status switch
    const toggle = screen.getByRole("switch", {
      name: /disable.*weekday/i,
    });
    await user.click(toggle);

    // Schedule content should remain visible — no flash to empty state
    expect(
      screen.getAllByText("Summarize yesterday's threads")[0],
    ).toBeInTheDocument();
    expect(screen.queryByText("No runs scheduled")).not.toBeInTheDocument();
  });
});
