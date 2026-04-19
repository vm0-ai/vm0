import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockOrgMembers } from "../../../mocks/handlers/api-org-members.ts";

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
  it("navigates to agent detail page when avatar link is clicked (CHAT-N-010)", async () => {
    const user = userEvent.setup();
    mockChatAPI();
    detachedSetupPage({ context, path: "/" });

    const link = await waitFor(() => {
      return screen.getByLabelText("View agent profile");
    });

    await user.click(link);

    await waitFor(() => {
      expect(screen.getAllByText(/Scheduled/i).length).toBeGreaterThan(0);
    });
  });
});

describe("zero chat page - pin button", () => {
  it("pin button adds the agent to pinned list (CHAT-I-011)", async () => {
    const user = userEvent.setup();
    mockSubagentTeam();
    mockChatAPI();
    detachedSetupPage({ context, path: `/agents/${SUBAGENT_ID}/chat` });

    const pinButton = await waitFor(() => {
      return screen.getByLabelText("Pin to sidebar");
    });

    await user.click(pinButton);

    await waitFor(() => {
      expect(
        within(screen.getByRole("navigation", { name: "Sidebar" })).getByText(
          "Test Subagent",
        ),
      ).toBeInTheDocument();
    });
  });
});

describe("zero chat page - invite button", () => {
  it("invite button opens manage dialog on members tab (CHAT-I-012)", async () => {
    const user = userEvent.setup();
    setMockOrgMembers({
      slug: "test-org",
      role: "admin",
      members: [],
      pendingInvitations: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    mockChatAPI();
    detachedSetupPage({ context, path: "/" });

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
  });
});

describe("zero chat page - ideas navigation", () => {
  it("ideas card navigates to ideation page (CHAT-N-014)", async () => {
    const user = userEvent.setup();
    mockSubagentTeam();
    mockChatAPI();
    detachedSetupPage({ context, path: `/agents/${SUBAGENT_ID}/chat` });

    await waitFor(() => {
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });

    const ideasButton = screen
      .getByText("Ideas & use cases")
      .closest("button")!;
    await user.click(ideasButton);

    await waitFor(() => {
      expect(
        screen.getByText(/Click any card to start a conversation/),
      ).toBeInTheDocument();
    });
  });
});
