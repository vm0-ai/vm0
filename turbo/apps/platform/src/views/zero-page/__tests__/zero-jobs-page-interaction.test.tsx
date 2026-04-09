import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const DEFAULT_AGENT = Object.freeze({
  id: "c0000000-0000-4000-a000-000000000001",
  displayName: null,
  description: null,
  sound: null,
  avatarUrl: null,
  headVersionId: "version_1",
  updatedAt: "2024-01-01T00:00:00Z",
});

function mockTeamAPI(
  extraAgents: {
    id: string;
    displayName: string | null;
    description: string | null;
    sound: null;
    avatarUrl: string | null;
    headVersionId: string;
    updatedAt: string;
  }[] = [],
) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([DEFAULT_AGENT, ...extraAgents]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByText("New agent")).toBeInTheDocument();
  });
  await user.click(screen.getByText("New agent"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("zero jobs page - create agent dialog", () => {
  it("opens the dialog when create agent button is clicked (AGENT-D-008)", async () => {
    const user = userEvent.setup();
    mockTeamAPI();
    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("New agent")).toBeInTheDocument();
    });
    await user.click(screen.getByText("New agent"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it("creates agent and shows it in the grid (AGENT-D-014)", async () => {
    const user = userEvent.setup();
    const NEW_AGENT = {
      id: "new-agent-id",
      displayName: "Marketing Bot",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_new",
      updatedAt: "2024-01-03T00:00:00Z",
    };
    let teamCallCount = 0;
    server.use(
      http.get("*/api/zero/team", () => {
        teamCallCount++;
        if (teamCallCount === 1) {
          return HttpResponse.json([DEFAULT_AGENT]);
        }
        return HttpResponse.json([DEFAULT_AGENT, NEW_AGENT]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.post("*/api/zero/agents", () => {
        return HttpResponse.json(
          {
            agentId: "new-agent-id",
            ownerId: "test-user-123",
            description: null,
            displayName: "Marketing Bot",
            sound: null,
            avatarUrl: null,
            connectors: [],
            permissionPolicies: null,
            allowUnknownEndpoints: null,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-agent-id/instructions", () => {
        return HttpResponse.json({
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: "Marketing Bot",
          sound: null,
          avatarUrl: null,
          connectors: [],
          permissionPolicies: null,
          allowUnknownEndpoints: null,
        });
      }),
    );

    await setupPage({ context, path: "/agents" });
    await openDialog(user);

    const input = screen.getByPlaceholderText("e.g. Research Assistant");
    await fill(input, "Marketing Bot");

    await user.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(screen.getByText("Marketing Bot")).toBeInTheDocument();
    });
  });

  it("closes the dialog when cancel is clicked (AGENT-D-015)", async () => {
    const user = userEvent.setup();
    mockTeamAPI();
    await setupPage({ context, path: "/agents" });

    await openDialog(user);

    await user.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

describe("zero jobs page - avatar display", () => {
  it("renders avatar for agents in the grid (AGENT-D-012)", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          DEFAULT_AGENT,
          {
            id: "avatar-agent-id",
            displayName: "Avatar Agent",
            description: "Has a custom SVG avatar",
            sound: null,
            avatarUrl: "svg:r2s1h4c3f2m",
            headVersionId: "version_av",
            updatedAt: "2024-01-02T00:00:00Z",
          },
        ]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );
    await setupPage({ context, path: "/agents" });

    // Agent with SVG avatar should render an avatar image
    await waitFor(() => {
      const avatar = screen.getByRole("img", { name: "Avatar Agent" });
      expect(avatar).toBeInTheDocument();
    });
  });

  it("renders fallback avatar when avatarUrl is null (AGENT-D-013)", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          DEFAULT_AGENT,
          {
            id: "no-avatar-agent-id",
            displayName: "No Avatar Agent",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "version_no",
            updatedAt: "2024-01-02T00:00:00Z",
          },
        ]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );
    await setupPage({ context, path: "/agents" });

    // Even without an avatar URL, a fallback SVG avatar should render
    await waitFor(() => {
      const avatar = screen.getByRole("img", { name: "No Avatar Agent" });
      expect(avatar).toBeInTheDocument();
    });
  });
});

describe("zero jobs page - navigation", () => {
  it("navigates to agent detail when an agent card is clicked (AGENT-D-009)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          DEFAULT_AGENT,
          {
            id: "nav-agent-id",
            displayName: "Nav Agent",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "version_nav",
            updatedAt: "2024-01-02T00:00:00Z",
          },
        ]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );
    await setupPage({ context, path: "/agents" });

    const card = await waitFor(() => {
      return screen.getByText("Nav Agent");
    });
    await user.click(card);

    await waitFor(() => {
      expect(pathname()).toBe("/agents/nav-agent-id");
    });
  });
});
