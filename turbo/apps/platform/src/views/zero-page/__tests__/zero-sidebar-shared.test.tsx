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
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
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

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      const img = within(sidebar).getByRole("img", { name: "DB Agent" });
      expect(img).toHaveAttribute("src", "https://example.com/my-avatar.png");
    });
  });
});

describe("agent avatar shows fallback when no image (SIDEBAR-D-043)", () => {
  it("renders SVG fallback when avatarUrl is null", async () => {
    mockBaseAPIs([
      { id: DEFAULT_AGENT_ID, displayName: null, avatarUrl: null },
      {
        id: PINNED_AGENT_ID,
        displayName: "Fallback Agent",
        avatarUrl: null,
      },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      // Fallback renders SVG layers (multiple img elements) instead of a single img
      const imgs = within(sidebar).getAllByRole("img", {
        name: "Fallback Agent",
      });
      expect(imgs.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("agent avatar renders SVG for preset value (SIDEBAR-D-045)", () => {
  it("renders SVG avatar layers when avatarUrl is preset:2", async () => {
    mockBaseAPIs([
      { id: DEFAULT_AGENT_ID, displayName: null, avatarUrl: null },
      {
        id: PINNED_AGENT_ID,
        displayName: "Preset Agent",
        avatarUrl: "preset:2",
      },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      // preset:2 renders as SVG layers via AvatarSvgPreview (role="img" with aria-label)
      const avatar = within(sidebar).getByRole("img", {
        name: "Preset Agent",
      });
      expect(avatar).toBeInTheDocument();
    });
  });
});

describe("agent avatar renders SVG for custom svg: value (SIDEBAR-D-046)", () => {
  it("renders SVG avatar layers when avatarUrl is svg:r1s0h3c2f1d", async () => {
    mockBaseAPIs([
      { id: DEFAULT_AGENT_ID, displayName: null, avatarUrl: null },
      {
        id: PINNED_AGENT_ID,
        displayName: "SVG Agent",
        avatarUrl: "svg:r1s0h3c2f1d",
      },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      const sidebar = getSidebar();
      const avatar = within(sidebar).getByRole("img", { name: "SVG Agent" });
      expect(avatar).toBeInTheDocument();
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
    );

    detachedSetupPage({ context, path: "/" });

    // While team API is still pending, no avatar img should be rendered
    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });
    const sidebar = getSidebar();
    expect(within(sidebar).queryAllByRole("img")).toHaveLength(0);

    deferred.resolve();

    // After team data resolves, the fallback avatar img appears
    await waitFor(() => {
      expect(
        within(getSidebar()).getByRole("img", { name: "Loading Agent" }),
      ).toBeInTheDocument();
    });
  });
});
