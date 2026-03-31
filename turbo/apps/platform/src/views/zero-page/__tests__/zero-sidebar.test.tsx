import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
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
    },
    {
      id: "thread-2",
      title: "Second chat",
      agentId: "c0000000-0000-4000-a000-000000000001",
      createdAt: "2026-03-09T00:00:00Z",
      updatedAt: "2026-03-09T00:00:00Z",
    },
  ],
}: {
  threads?: {
    id: string;
    title: string;
    agentId: string;
    createdAt: string;
    updatedAt: string;
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
  );
}

function mockAPIsWithSubagents() {
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
        {
          id: "sub-agent-id",
          displayName: "Research Agent",
          description: "Finds information",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({
        threads: [
          {
            id: "thread-main",
            title: "Main agent chat",
            agentId: "c0000000-0000-4000-a000-000000000001",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          },
          {
            id: "thread-sub",
            title: "Sub agent chat",
            agentId: "sub-agent-id",
            createdAt: "2026-03-09T00:00:00Z",
            updatedAt: "2026-03-09T00:00:00Z",
          },
        ],
      });
    }),
  );
}

describe("zero sidebar", () => {
  it("should render clerk org switcher", async () => {
    await setupPage({
      context,
      path: "/",
    });

    expect(screen.getByText("OrganizationSwitcher")).toBeInTheDocument();
  });

  it("should enable dataExport feature switch via localStorage override", async () => {
    await setupPage({
      context,
      path: "/",
      featureSwitches: { dataExport: true },
    });

    const features = await context.store.get(featureSwitch$);
    expect(features[FeatureSwitchKey.DataExport]).toBeTruthy();
  });

  it("should disable dataExport feature switch when not overridden", async () => {
    await setupPage({
      context,
      path: "/",
      featureSwitches: { dataExport: false },
    });

    const features = await context.store.get(featureSwitch$);
    expect(features[FeatureSwitchKey.DataExport]).toBeFalsy();
  });

  it("should filter chat sessions when searching", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/" });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });
    expect(screen.getByText("Second chat")).toBeInTheDocument();

    // Click search button
    const searchButton = screen.getByRole("button", { name: "Search chats" });
    await user.click(searchButton);

    // Type search query
    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await user.clear(searchInput);
    await user.type(searchInput, "First");

    // Only matching thread should be visible
    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();
  });

  it("should close search and reset filter", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await setupPage({ context, path: "/" });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    // Open search
    const searchButton = screen.getByRole("button", { name: "Search chats" });
    await user.click(searchButton);

    // Type search query that filters out one thread
    const searchInput = screen.getByPlaceholderText("Search chat with Zero");
    await user.clear(searchInput);
    await user.type(searchInput, "First");

    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();

    // Close search
    const closeButton = screen.getByRole("button", { name: "Close search" });
    await user.click(closeButton);

    // Both threads should be visible again (search term was reset)
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });
    expect(screen.getByText("Second chat")).toBeInTheDocument();
  });

  it("should only show main agent chats on default route", async () => {
    mockAPIsWithSubagents();
    await setupPage({ context, path: "/" });

    // Wait for main agent chat to render
    await waitFor(() => {
      expect(screen.getByText("Main agent chat")).toBeInTheDocument();
    });

    // Sub-agent chat should not appear in the default view
    expect(screen.queryByText("Sub agent chat")).not.toBeInTheDocument();
  });

  it("should show sub-agent chats when navigating to /talk/:name", async () => {
    mockAPIsWithSubagents();
    await setupPage({ context, path: "/talk/sub-agent-id" });

    // Wait for sub-agent chat to render
    await waitFor(() => {
      expect(screen.getByText("Sub agent chat")).toBeInTheDocument();
    });

    // Main agent chat should not appear in the sub-agent view
    expect(screen.queryByText("Main agent chat")).not.toBeInTheDocument();
  });
});
