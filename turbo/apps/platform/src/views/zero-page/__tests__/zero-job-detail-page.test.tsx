import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
} from "@vm0/core";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";

const context = testContext();

function mockAPIs() {
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-detail-id",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
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
    click(profileTab!);

    // Profile tab should show settings form with agent name input
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });
  });

  it("should show not-found error for unknown agent", async () => {
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "INTERNAL_SERVER_ERROR" },
        });
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
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-detail-id",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
  setMockSchedules([
    createMockScheduleResponse({
      id: "f0000002-0000-4000-a000-000000000001",
      agentId: "e0000000-0000-4000-a000-000000000010",
      name: "morning-briefing",
      cronExpression: "0 9 * * 1-5",
      prompt: "Summarize yesterday's threads",
    }),
  ]);
}

async function openScheduleMenuAndClick(
  timeLabel: string,
  action: "Edit" | "Delete" | "Run now",
) {
  const menuTrigger = screen.getAllByLabelText(
    `More actions for ${timeLabel}`,
  )[0];
  click(menuTrigger);
  await waitFor(() => {
    expect(screen.getByText(action)).toBeInTheDocument();
  });
  click(screen.getByText(action));
}

describe("zero job detail page - schedule card delete confirmation", () => {
  it("should show confirmation dialog when delete button is clicked in card view", async () => {
    mockAPIsWithSchedules();
    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openScheduleMenuAndClick("Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
    expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("should close dialog without deleting when Cancel is clicked in card view", async () => {
    let deleteCalled = false;

    mockAPIsWithSchedules();
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ respond }) => {
        deleteCalled = true;
        return respond(204);
      }),
    );

    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openScheduleMenuAndClick("Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deleteCalled).toBeFalsy();
  });

  it("should call delete API when Delete is confirmed in card view", async () => {
    let deletedName: string | null = null;

    mockAPIsWithSchedules();
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ params, respond }) => {
        deletedName = params.name;
        return respond(204);
      }),
    );

    detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openScheduleMenuAndClick("Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(deletedName).toBe("morning-briefing");
    });
  });
});

describe("zero job detail page - schedule tab toggle", () => {
  it("should not flash empty state when toggling schedule status", async () => {
    mockAPIsWithSchedules();

    server.use(
      mockApi(zeroSchedulesEnableContract.disable, ({ respond }) => {
        return respond(
          200,
          createMockScheduleResponse({
            id: "f0000002-0000-4000-a000-000000000001",
            agentId: "e0000000-0000-4000-a000-000000000010",
            name: "morning-briefing",
            cronExpression: "0 9 * * 1-5",
            prompt: "Summarize yesterday's threads",
            enabled: false,
          }),
        );
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
    click(toggle);

    // Schedule content should remain visible — no flash to empty state
    expect(
      screen.getAllByText("Summarize yesterday's threads")[0],
    ).toBeInTheDocument();
    expect(screen.queryByText("No runs scheduled")).not.toBeInTheDocument();
  });
});
