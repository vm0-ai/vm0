import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
  onboardingCompleteContract,
} from "@vm0/core";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

function mockOnboardingNeededAdmin() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      });
    }),
    // Single setup endpoint replaces all individual onboarding API calls
    mockApi(onboardingSetupContract.setup, ({ respond }) => {
      return respond(200, { agentId: MOCK_AGENT_ID });
    }),
  );
}

function mockOnboardingNeededMember() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: { displayName: "Zero" },
      });
    }),
    // Mock complete member onboarding
    mockApi(onboardingCompleteContract.complete, ({ respond }) => {
      return respond(200, { ok: true });
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
    mockOnboardingNeededAdmin();

    detachedSetupPage({ context, path: "/onboarding" });

    // Step 1: Workspace name
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    // Fill name and advance
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    click(screen.getByText("Next"));

    // Step 2: Choose your tools — select a connector so step 3 is visible
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    click(screen.getByTestId("connector-card-github"));
    click(screen.getByText("Next"));

    // Step 3: Connect your apps → Next
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    click(screen.getByText("Next"));

    // Step 4: Where to work
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // After completing onboarding, the API should report needsOnboarding: false
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: null,
        });
      }),
    );

    // Click "Continue in web" to trigger handleContinueWithWeb -> navigate("/")
    const continueButton = screen.getByText(/Continue in web/);
    click(continueButton);

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

    // Member lands on step 2 (Choose your tools) under the unified flow
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
  });

  it("should navigate to / after completing member onboarding via web", async () => {
    mockOnboardingNeededMember();

    detachedSetupPage({ context, path: "/onboarding" });

    // Member starts on step 2 — advance without selecting connectors to land
    // on step 4 (where-to-work).
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // After completing onboarding, the API should report needsOnboarding: false
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: "c0000000-0000-4000-a000-000000000001",
          defaultAgentMetadata: { displayName: "Zero" },
        });
      }),
    );

    // Click "Continue in web" to trigger handleContinueWeb -> navigate("/")
    const chatButton = screen.getByText(/Continue in web/);
    click(chatButton);

    // Verify navigation away from /onboarding (/ redirects to /talk/:name)
    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });
  });

  it("should forward ?prompt= and ?connector= to /onboarding", async () => {
    mockOnboardingNeededAdmin();

    detachedSetupPage({
      context,
      path: "/?prompt=summarize%20this&connector=gmail,slack",
    });

    await waitFor(() => {
      expect(pathname()).toBe("/onboarding");
    });

    const forwarded = new URLSearchParams(search());
    expect(forwarded.get("prompt")).toBe("summarize this");
    expect(forwarded.get("connector")).toBe("gmail,slack");
  });

  it("should redirect to /onboarding without query string when no params", async () => {
    mockOnboardingNeededAdmin();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(pathname()).toBe("/onboarding");
    });

    expect(search()).toBe("");
  });
});
