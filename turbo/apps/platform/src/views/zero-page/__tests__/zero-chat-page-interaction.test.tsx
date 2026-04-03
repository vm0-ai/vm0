import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { getCategories } from "../zero-ideation-data.ts";

const context = testContext();

const SUBAGENT_ID = "subagent-0000-4000-a000-000000000002";

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockSubagentTeam() {
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
          id: SUBAGENT_ID,
          displayName: "Test Subagent",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
  );
}

describe("zero chat page - agent avatar link", () => {
  it("navigates to /agents/:id when avatar link is clicked (CHAT-N-010)", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    await setupPage({ context, path: "/" });

    const link = await waitFor(() => {
      return screen.getByRole("link", { name: "View agent profile" });
    });

    await user.click(link);

    await waitFor(() => {
      expect(pathname()).toBe("/agents/c0000000-0000-4000-a000-000000000001");
    });
  });
});

describe("zero chat page - pin button", () => {
  it("pin button adds the agent to pinned list (CHAT-I-011)", async () => {
    const user = userEvent.setup();
    mockSubagentTeam();
    mockChatAPI();
    await setupPage({ context, path: `/agents/${SUBAGENT_ID}/chat` });

    const pinButton = await waitFor(() => {
      return screen.getByRole("button", { name: "Pin to sidebar" });
    });

    await user.click(pinButton);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Pin to sidebar" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("zero chat page - invite button", () => {
  it("invite button opens manage dialog on members tab (CHAT-I-012)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/zero/org/members", () => {
        return HttpResponse.json({
          slug: "test-org",
          role: "admin",
          members: [],
          pendingInvitations: [],
          createdAt: "2026-01-01T00:00:00Z",
        });
      }),
    );
    mockChatAPI();
    await setupPage({ context, path: "/" });

    const inviteButton = await waitFor(() => {
      return screen.getByTestId("invite-button");
    });

    await waitFor(() => {
      expect(inviteButton).not.toHaveAttribute("aria-hidden", "true");
    });

    await user.click(inviteButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Manage who has access to this workspace."),
    ).toBeInTheDocument();
  });
});

describe("zero chat page - suggested prompt", () => {
  it("clicking a prompt card populates the composer textarea (CHAT-I-013)", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    await setupPage({ context, path: "/" });

    const allUseCases = getCategories().flatMap((c) => {
      return c.cases;
    });
    const promptByTitle = new Map(
      allUseCases.map((u) => {
        return [u.title, u.prompt];
      }),
    );

    const exploreButton = await waitFor(() => {
      return screen.getByRole("button", { name: /Ideas & use cases/ });
    });
    const promptGrid = exploreButton.parentElement!;
    const gridButtons = within(promptGrid).getAllByRole("button");

    const promptCard = gridButtons.find((btn) => {
      return !btn.textContent?.includes("Ideas & use cases");
    })!;

    const cardTitle = [...promptByTitle.keys()].find((title) => {
      return promptCard.textContent?.includes(title);
    })!;
    const expectedPrompt = promptByTitle.get(cardTitle)!;

    await user.click(promptCard);

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      );
      expect(textarea).toHaveValue(expectedPrompt);
    });
  });
});

describe("zero chat page - ideas navigation", () => {
  it("ideas card navigates to /agents/:id/ideas (CHAT-N-014)", async () => {
    const user = userEvent.setup();
    mockSubagentTeam();
    mockChatAPI();
    await setupPage({ context, path: `/agents/${SUBAGENT_ID}/chat` });

    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });

    const ideasButton = screen
      .getByText("Ideas & use cases")
      .closest("button")!;
    await user.click(ideasButton);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${SUBAGENT_ID}/ideas`);
    });
  });
});
