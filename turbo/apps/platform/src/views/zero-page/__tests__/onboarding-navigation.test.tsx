import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

function mockOnboardingNeededAdmin() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
        defaultAgentSkills: [],
      });
    }),
    // Single setup endpoint replaces all individual onboarding API calls
    http.post("*/api/zero/onboarding/setup", () => {
      return HttpResponse.json({ agentId: MOCK_AGENT_ID });
    }),
    // Mock chat threads for the home page
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockOnboardingNeededMember() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
    // Mock complete member onboarding
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
    // Mock chat threads for the home page
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("onboarding navigation", () => {
  it("should redirect to /onboarding when admin needs onboarding", async () => {
    mockOnboardingNeededAdmin();

    detachedSetupPage({ context, path: "/" });

    // The / route should redirect to /onboarding
    await waitFor(() => {
      expect(pathname()).toBe("/onboarding");
    });

    // Onboarding step 1 should be rendered
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });
  });

  it("should navigate to / after completing admin onboarding via web", async () => {
    const user = userEvent.setup();
    mockOnboardingNeededAdmin();

    detachedSetupPage({ context, path: "/onboarding" });

    // Step 1: Workspace name
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    // Fill name and advance
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    await user.click(screen.getByText("Next"));

    // Step 2: Choose your tools → Next
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    // Step 3: Connect your apps → Next
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    // Step 4: Where to work
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // After completing onboarding, the API should report needsOnboarding: false
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: null,
          defaultAgentSkills: [],
        });
      }),
    );

    // Click "Continue in web" to trigger handleContinueWithWeb -> navigate("/")
    const continueButton = screen.getByText(/Continue in web/);
    await user.click(continueButton);

    // Verify navigation to / (which then redirects to /talk/:name)
    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });
  });

  it("should redirect to /onboarding when member needs onboarding", async () => {
    mockOnboardingNeededMember();

    detachedSetupPage({ context, path: "/" });

    // The / route should redirect to /onboarding
    await waitFor(() => {
      expect(pathname()).toBe("/onboarding");
    });

    // Member goes straight to step 4 (where-to-work) with no connectors
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });
  });

  it("should navigate to / after completing member onboarding via web", async () => {
    const user = userEvent.setup();
    mockOnboardingNeededMember();

    detachedSetupPage({ context, path: "/onboarding" });

    // Member with no connectors goes straight to step 4 (where-to-work)
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // After completing onboarding, the API should report needsOnboarding: false
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: "c0000000-0000-4000-a000-000000000001",
          defaultAgentMetadata: { displayName: "Zero" },
          defaultAgentSkills: [],
        });
      }),
    );

    // Click "Continue in web" to trigger handleContinueWeb -> navigate("/")
    const chatButton = screen.getByText(/Continue in web/);
    await user.click(chatButton);

    // Verify navigation away from /onboarding (/ redirects to /talk/:name)
    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });
  });
});
