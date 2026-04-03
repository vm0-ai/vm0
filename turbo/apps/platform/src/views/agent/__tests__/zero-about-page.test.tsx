import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  setZeroShowAboutPage$,
  zeroShowAboutPage$,
} from "../../../signals/zero-page/zero-nav.ts";

const context = testContext();

function mockBasicAPIs() {
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
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockTeamAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-detail-id",
          name: "my-agent",
          displayName: "My Agent",
          description: "A helpful agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        connectors: [],
        firewallPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [] });
    }),
  );
}

describe("zero about page", () => {
  // AGENT-D-072: Agent display name renders in content
  it("renders agent display name in content", async () => {
    mockBasicAPIs();
    await setupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(screen.getByText(/Zero is your AI teammate/i)).toBeInTheDocument();
    });
  });

  // AGENT-D-073: Dynamic text interpolation with name
  it("interpolates agent display name in section headings", async () => {
    mockBasicAPIs();
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: "c0000000-0000-4000-a000-000000000001",
          defaultAgentMetadata: { displayName: "MyAgent" },
          defaultAgentSkills: [],
        });
      }),
    );
    await setupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(screen.getByText(/Who MyAgent is for/i)).toBeInTheDocument();
    });
  });

  // AGENT-D-074: Back button navigates back
  it("back button hides the about page", async () => {
    const user = userEvent.setup();
    mockBasicAPIs();
    await setupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /back/i }));

    expect(context.store.get(zeroShowAboutPage$)).toBeFalsy();
  });

  // AGENT-D-075: External link opens vm0.ai
  it("renders external link to vm0.ai", async () => {
    mockBasicAPIs();
    await setupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /Learn more at vm0\.ai/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "https://vm0.ai");
      expect(link).toHaveAttribute("target", "_blank");
    });
  });
});

describe("zero team detail page", () => {
  // AGENT-S-003: Agent detail renders when agentId available
  it("renders ZeroJobDetailPage when agentId is available", async () => {
    mockTeamAPIs();
    await setupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });
  });
});
