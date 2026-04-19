import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { featureSwitch$ } from "../../../signals/external/feature-switch";
import { FeatureSwitchKey } from "@vm0/core";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";

const context = testContext();

function mockAPIs({
  threads = [
    {
      id: "thread-1",
      title: "First chat",
      agentId: "c0000000-0000-4000-a000-000000000001",
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    },
    {
      id: "thread-2",
      title: "Second chat",
      agentId: "c0000000-0000-4000-a000-000000000001",
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
    agentId: string;
    createdAt: string;
    updatedAt: string;
    isRead: boolean;
    isArchived: boolean;
    running: boolean;
  }[];
} = {}) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
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
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads });
    }),
    http.get("*/api/zero/agents/:id", () => {
      return HttpResponse.json({
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
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

  it("should hide Activity logs when ActivityLogList switch is off", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: false },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.queryByText("Activity logs")).not.toBeInTheDocument();
  });

  it("should show Activity logs when ActivityLogList switch is on", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.getByText("Activity logs")).toBeInTheDocument();
  });

  it("should filter chat sessions when searching", async () => {
    const user = userEvent.setup();
    mockAPIs();
    detachedSetupPage({ context, path: "/" });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });
    expect(screen.getByText("Second chat")).toBeInTheDocument();

    // Click search button
    const searchButton = screen.getByLabelText("Search chats");
    await user.click(searchButton);

    // Type search query
    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await fill(searchInput, "First");

    // Only matching thread should be visible
    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();
  });

  it("should close search and reset filter", async () => {
    const user = userEvent.setup();
    mockAPIs();
    detachedSetupPage({ context, path: "/" });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    // Open search
    const searchButton = screen.getByLabelText("Search chats");
    await user.click(searchButton);

    // Type search query that filters out one thread
    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await fill(searchInput, "First");

    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();

    // Close search
    const closeButton = screen.getByLabelText("Close search");
    await user.click(closeButton);

    // Both threads should be visible again (search term was reset)
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });
    expect(screen.getByText("Second chat")).toBeInTheDocument();
  });
});
