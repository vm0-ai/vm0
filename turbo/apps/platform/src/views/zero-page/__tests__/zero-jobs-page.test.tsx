import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function createMockTeamWithSubagents() {
  return [
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
      id: "agent-2",
      name: "research-agent",
      displayName: "Research Agent",
      description: "Finds and summarizes information",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
      isOwner: false,
    },
    {
      id: "agent-3",
      name: "writer",
      displayName: null,
      description: "Writes content based on research",
      headVersionId: "version_3",
      updatedAt: "2024-01-03T00:00:00Z",
      isOwner: false,
    },
  ];
}

function mockTeamAPI(composes = createMockTeamWithSubagents()) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json({ composes });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockTeamAPIError() {
  server.use(
    http.get("*/api/zero/team", () => {
      return new HttpResponse(null, {
        status: 500,
        statusText: "Internal Server Error",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderTeamPage() {
  await setupPage({ context, path: "/team" });
}

describe("zero jobs page - team list", () => {
  it("should render team page with main agent and sub-agents", async () => {
    mockTeamAPI();
    await renderTeamPage();

    // Verify sub-agents render with correct names (including displayName fallback)
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Finds and summarizes information"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Writes content based on research"),
    ).toBeInTheDocument();
    // "writer" agent has displayName: null, so it should show the name "writer"
    expect(screen.getByText("writer")).toBeInTheDocument();
  });

  it("should show empty state when no sub-agents exist", async () => {
    mockTeamAPI([
      {
        id: "mock-compose-id",
        name: "zero",
        displayName: null,
        description: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
        isOwner: true,
      },
    ]);
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Just Zero for now")).toBeInTheDocument();
    });
  });

  it("should show create teammate button when sub-agents exist", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Create teammate")).toBeInTheDocument();
    });
  });

  it("should show error state with retry link when API fails", async () => {
    mockTeamAPIError();
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });
});
