import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { screen, waitFor } from "@testing-library/react";
import { featureSwitch$ } from "../../../signals/external/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { chatThreadsContract } from "@vm0/core/contracts/chat-threads";
import { zeroAgentsByIdContract } from "@vm0/core/contracts/zero-agents";
import { zeroTeamContract } from "@vm0/core/contracts/zero-team";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIs({
  threads = [
    {
      id: "thread-1",
      title: "First chat",
      agent: { id: "c0000000-0000-4000-a000-000000000001", avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    },
    {
      id: "thread-2",
      title: "Second chat",
      agent: { id: "c0000000-0000-4000-a000-000000000001", avatarUrl: null },
      createdAt: "2026-03-09T00:00:00Z",
      updatedAt: "2026-03-09T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    },
  ],
}: {
  threads?: {
    id: string;
    title: string;
    agent: { id: string; avatarUrl: string | null };
    createdAt: string;
    updatedAt: string;
    isRead: boolean;
    isArchived: boolean;
    running: boolean;
  }[];
} = {}) {
  server.use(
    mockApi(zeroTeamContract.list, ({ respond }) => {
      return respond(200, [
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
    }),
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads });
    }),
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
  );
}

describe("zero sidebar", () => {
  it("should render org switcher with current org name", async () => {
    detachedSetupPage({
      context,
      path: "/",
    });

    await waitFor(() => {
      expect(screen.getByText("Default Org")).toBeInTheDocument();
    });
  });

  it("should enable dataExport feature switch via localStorage override", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dataExport: true },
    });

    const features = await context.store.get(featureSwitch$);
    expect(features[FeatureSwitchKey.DataExport]).toBeTruthy();
  });

  it("should disable dataExport feature switch when not overridden", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dataExport: false },
    });

    const features = await context.store.get(featureSwitch$);
    expect(features[FeatureSwitchKey.DataExport]).toBeFalsy();
  });

  it("should hide Activity logs when ZeroDebug switch is off", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: false },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.queryByText("Activity logs")).not.toBeInTheDocument();
  });

  it("should show Activity logs when ZeroDebug switch is on", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.getByText("Activity logs")).toBeInTheDocument();
  });

  it("should filter chat sessions when searching", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
    });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });
    expect(screen.getByText("Second chat")).toBeInTheDocument();

    // Click search button
    const searchButton = screen.getByLabelText("Search chats");
    click(searchButton);

    // Type search query
    const searchInput = screen.getByPlaceholderText("Search chats");
    await fill(searchInput, "First");

    // Only matching thread should be visible
    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();
  });

  it("should close search and reset filter", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
    });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    // Open search
    const searchButton = screen.getByLabelText("Search chats");
    click(searchButton);

    // Type search query that filters out one thread
    const searchInput = screen.getByPlaceholderText("Search chats");
    await fill(searchInput, "First");

    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();

    // Close search
    const closeButton = screen.getByLabelText("Close search");
    click(closeButton);

    // Both threads should be visible again (search term was reset)
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });
    expect(screen.getByText("Second chat")).toBeInTheDocument();
  });
});
