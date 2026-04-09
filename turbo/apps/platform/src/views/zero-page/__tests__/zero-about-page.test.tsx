import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setZeroShowAboutPage$ } from "../../../signals/zero-page/zero-nav.ts";

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

describe("zero about page", () => {
  // AGENT-D-072: About page renders when flag is set
  it("renders the about page when zeroShowAboutPage is true", async () => {
    mockBasicAPIs();
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "About VM0 Zero" }),
      ).toBeInTheDocument();
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
      http.get("*/api/zero/agents/:id", () => {
        return HttpResponse.json({
          agentId: "c0000000-0000-4000-a000-000000000001",
          ownerId: "test-user",
          displayName: "MyAgent",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
        });
      }),
    );
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Who MyAgent is for/i }),
      ).toBeInTheDocument();
    });
  });

  // AGENT-D-074: Back button navigates back
  it("back button hides the about page", async () => {
    const user = userEvent.setup();
    mockBasicAPIs();
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(screen.getByText(/back/i)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/back/i));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "About VM0 Zero" }),
      ).not.toBeInTheDocument();
    });
  });

  // AGENT-D-075: External link opens vm0.ai
  it("renders external link to vm0.ai", async () => {
    mockBasicAPIs();
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      const link = document.querySelector('a[href="https://vm0.ai"]');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("target", "_blank");
    });
  });
});
