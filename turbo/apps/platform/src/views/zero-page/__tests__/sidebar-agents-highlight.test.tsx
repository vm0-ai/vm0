import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { navigate$ } from "../../../signals/route.ts";

const context = testContext();

function mockAgentAPIs() {
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
          id: "agent-abc",
          displayName: "Test Agent",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
  );
}

/**
 * Find the sidebar "Agents" manage-nav link inside the sidebar <nav>.
 */
function getAgentsNavLink(): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "Sidebar" });
  return within(nav).getByText("Agents").closest("a")!;
}

describe("sidebar Agents tab highlight", () => {
  it("should highlight Agents tab on /agents list page", async () => {
    mockAgentAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(getAgentsNavLink()).toBeInTheDocument();
    });

    // Navigate to /agents
    await context.store.set(navigate$, "/agents", {}, context.signal);

    await waitFor(() => {
      expect(getAgentsNavLink()).toHaveAttribute("aria-current", "page");
    });
  });

  it("should not highlight Agents tab on /agents/:id/chat", async () => {
    mockAgentAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(getAgentsNavLink()).toBeInTheDocument();
    });

    // Navigate to agent chat
    await context.store.set(
      navigate$,
      "/agents/agent-abc/chat",
      {},
      context.signal,
    );

    await waitFor(() => {
      expect(getAgentsNavLink()).not.toHaveAttribute("aria-current", "page");
    });
  });

  it("should not highlight Agents tab on /agents/:id/ideas", async () => {
    mockAgentAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(getAgentsNavLink()).toBeInTheDocument();
    });

    // Navigate to agent ideas
    await context.store.set(
      navigate$,
      "/agents/agent-abc/ideas",
      {},
      context.signal,
    );

    await waitFor(() => {
      expect(getAgentsNavLink()).not.toHaveAttribute("aria-current", "page");
    });
  });
});
