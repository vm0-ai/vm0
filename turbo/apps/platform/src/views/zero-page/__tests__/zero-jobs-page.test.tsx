import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function createMockAgentsWithSubagents() {
  return [
    {
      id: "mock-compose-id",
      name: "zero",
      displayName: null,
      headVersionId: "v1",
      updatedAt: "2024-01-01T00:00:00Z",
      isOwner: true,
    },
    {
      id: "agent-2",
      name: "researcher",
      displayName: "Researcher",
      description: "Finds information on any topic",
      headVersionId: "v2",
      updatedAt: "2024-01-02T00:00:00Z",
      isOwner: false,
    },
    {
      id: "agent-3",
      name: "writer",
      displayName: null,
      description: "Writes documentation",
      headVersionId: "v3",
      updatedAt: "2024-01-03T00:00:00Z",
      isOwner: false,
    },
  ];
}

interface MockCompose {
  id: string;
  name: string;
  displayName: string | null;
  headVersionId: string;
  updatedAt: string;
  isOwner: boolean;
  description?: string;
}

function mockTeamAPI(
  composes: MockCompose[] = [
    {
      id: "mock-compose-id",
      name: "zero",
      displayName: null,
      headVersionId: "v1",
      updatedAt: "2024-01-01T00:00:00Z",
      isOwner: true,
    },
  ],
) {
  server.use(
    http.get("*/api/zero/team", () => HttpResponse.json({ composes })),
    http.get("*/api/zero/chat-threads", () =>
      HttpResponse.json({ threads: [] }),
    ),
  );
}

async function renderTeamPage() {
  await setupPage({ context, path: "/team" });
}

describe("zero jobs page - header", () => {
  it("should render page title with agent name", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Zero's team" }),
      ).toBeInTheDocument();
    });
  });

  it("should render description about workflow orchestration", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(
        screen.getByText(/and sub-agents working together/),
      ).toBeInTheDocument();
    });
  });
});

describe("zero jobs page - main agent card", () => {
  it("should show main agent name with Lead badge", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Lead")).toBeInTheDocument();
    });
  });

  it("should show main agent description", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(
        screen.getByText(
          "Your primary AI assistant that manages your team and orchestrates workflows.",
        ),
      ).toBeInTheDocument();
    });
  });
});

describe("zero jobs page - empty state", () => {
  it("should show empty message when no sub-agents exist", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Just Zero for now")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Ask Zero to create a teammate/),
    ).toBeInTheDocument();
  });
});

describe("zero jobs page - sub-agents grid", () => {
  it("should render sub-agent cards with display names", async () => {
    mockTeamAPI(createMockAgentsWithSubagents());
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Researcher")).toBeInTheDocument();
    });
    // writer has no displayName, should fall back to name
    expect(screen.getByText("writer")).toBeInTheDocument();
  });

  it("should render descriptions on sub-agent cards", async () => {
    mockTeamAPI(createMockAgentsWithSubagents());
    await renderTeamPage();

    await waitFor(() => {
      expect(
        screen.getByText("Finds information on any topic"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Writes documentation")).toBeInTheDocument();
  });

  it("should show Workspace badge on sub-agent cards", async () => {
    mockTeamAPI(createMockAgentsWithSubagents());
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Researcher")).toBeInTheDocument();
    });
    const workspaceBadges = screen.getAllByText("Workspace");
    expect(workspaceBadges).toHaveLength(2);
  });

  it("should show create teammate link", async () => {
    mockTeamAPI(createMockAgentsWithSubagents());
    await renderTeamPage();

    await waitFor(() => {
      expect(
        screen.getByText(/Start a chat to create a new teammate/),
      ).toBeInTheDocument();
    });
  });
});

describe("zero jobs page - error state", () => {
  it("should show error message and retry link", async () => {
    server.use(
      http.get("*/api/zero/team", () =>
        HttpResponse.json({ error: "Internal Server Error" }, { status: 500 }),
      ),
    );
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });
});
