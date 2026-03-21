import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { act, screen, waitFor, fireEvent } from "@testing-library/react";
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
      preview: "Hello world",
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "thread-2",
      title: "Second chat",
      preview: "Goodbye moon",
      createdAt: "2026-03-09T00:00:00Z",
      updatedAt: "2026-03-09T00:00:00Z",
    },
  ],
}: {
  threads?: {
    id: string;
    title: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
  }[];
} = {}) {
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
      return HttpResponse.json({ threads });
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
    mockAPIs();
    await setupPage({ context, path: "/" });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
    expect(screen.getByText("Goodbye moon")).toBeInTheDocument();

    // Click search button
    const searchButton = screen.getByRole("button", { name: "Search chats" });
    await act(() => {
      searchButton.click();
    });

    // Type search query
    const searchInput = screen.getByPlaceholderText("Search chats...");
    await act(() => {
      fireEvent.change(searchInput, { target: { value: "Hello" } });
    });

    // Only matching thread should be visible
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.queryByText("Goodbye moon")).not.toBeInTheDocument();
  });

  it("should close search and reset filter", async () => {
    mockAPIs();
    await setupPage({ context, path: "/" });

    // Wait for chat threads to render
    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });

    // Open search
    const searchButton = screen.getByRole("button", { name: "Search chats" });
    await act(() => {
      searchButton.click();
    });

    // Type search query that filters out one thread
    const searchInput = screen.getByPlaceholderText("Search chats...");
    await act(() => {
      fireEvent.change(searchInput, { target: { value: "Hello" } });
    });

    expect(screen.queryByText("Goodbye moon")).not.toBeInTheDocument();

    // Close search
    const closeButton = screen.getByRole("button", { name: "Close search" });
    await act(() => {
      closeButton.click();
    });

    // Both threads should be visible again (search term was reset)
    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
    expect(screen.getByText("Goodbye moon")).toBeInTheDocument();
  });
});
