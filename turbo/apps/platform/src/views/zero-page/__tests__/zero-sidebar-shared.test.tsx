/**
 * Tests for zero-sidebar-shared.tsx — AgentAvatarImg component.
 *
 * Covers:
 *  SIDEBAR-D-042 — avatar renders from database URL
 *  SIDEBAR-D-043 — fallback avatar when no image
 *  SIDEBAR-D-044 — loading state shows no image initially
 *
 * Follows platform testing principles:
 * - Entry point: setupPage({ context, path })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PINNED_AGENT_ID = "c0000000-0000-4000-a000-000000000002";

function mockBaseAPIs(
  agents: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
  }[],
): void {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json(
        agents.map((a) => {
          return {
            ...a,
            description: null,
            sound: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          };
        }),
      );
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });
});

describe("agent avatar renders from database (SIDEBAR-D-042)", () => {
  it("renders img element with database URL as src when avatarUrl is set", async () => {
    mockBaseAPIs([
      { id: DEFAULT_AGENT_ID, displayName: null, avatarUrl: null },
      {
        id: PINNED_AGENT_ID,
        displayName: "DB Agent",
        avatarUrl: "https://example.com/my-avatar.png",
      },
    ]);

    await setupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      const img = within(sidebar).getByRole("img", { name: "DB Agent" });
      expect(img).toHaveAttribute("src", "https://example.com/my-avatar.png");
    });
  });
});

describe("agent avatar shows fallback when no image (SIDEBAR-D-043)", () => {
  it("renders img element with fallback preset when avatarUrl is null", async () => {
    mockBaseAPIs([
      { id: DEFAULT_AGENT_ID, displayName: null, avatarUrl: null },
      {
        id: PINNED_AGENT_ID,
        displayName: "Fallback Agent",
        avatarUrl: null,
      },
    ]);

    await setupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      const img = within(sidebar).getByRole("img", { name: "Fallback Agent" });
      expect(img.getAttribute("src")).toMatch(/avatar_1/);
    });
  });
});

describe("avatar loading state shows no image initially (SIDEBAR-D-044)", () => {
  it("shows no avatar image until the agent data resolves", async () => {
    const deferred = createDeferredPromise<void>(context.signal);

    server.use(
      http.get("*/api/zero/team", async () => {
        await deferred.promise;
        return HttpResponse.json([
          {
            id: DEFAULT_AGENT_ID,
            displayName: null,
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
          {
            id: PINNED_AGENT_ID,
            displayName: "Loading Agent",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({ context, path: "/" });

    // While team API is still pending, no avatar img should be rendered
    const sidebar = getSidebar();
    expect(within(sidebar).queryAllByRole("img")).toHaveLength(0);

    deferred.resolve();

    // After team data resolves, the fallback avatar img appears
    await waitFor(() => {
      expect(
        within(sidebar).getByRole("img", { name: "Loading Agent" }),
      ).toBeInTheDocument();
    });
  });
});
