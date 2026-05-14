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
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
const MEMBER_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

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
    // Single setup endpoint provisions the workspace + default agent.
    mockApi(onboardingSetupContract.setup, ({ respond }) => {
      return respond(200, { agentId: MOCK_AGENT_ID });
    }),
  );
}

// Non-admins (and admins whose workspace is already set up) never need
// onboarding — the backend reports needsOnboarding: false for them.
function mockNoOnboardingNeeded() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: false,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MEMBER_AGENT_ID,
        defaultAgentMetadata: { displayName: "Zero" },
      });
    }),
  );
}

function registerAgent(id: string) {
  setMockTeam([
    {
      id,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
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

    // Fill name and advance — this eager-inits the workspace + default agent
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    click(screen.getByText("Next"));

    // Step 2: Choose your tools — pick a connector to authorize
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    click(screen.getByTestId("connector-card-github"));

    // After completing onboarding, the API reports needsOnboarding: false
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
    // Register the new default agent so the subsequent chat page setup can
    // find it instead of treating it as missing and looping back.
    registerAgent(MOCK_AGENT_ID);

    // "Get Started" finishes onboarding (step 2 is the terminal step) and
    // navigates into the web chat.
    await waitFor(() => {
      expect(screen.getByText(/Get Started/)).toBeInTheDocument();
    });
    click(screen.getByText(/Get Started/));

    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });
  });

  it("should send users who don't need onboarding to / instead of /onboarding", async () => {
    mockNoOnboardingNeeded();
    registerAgent(MEMBER_AGENT_ID);

    detachedSetupPage({ context, path: "/onboarding" });

    // The onboarding page has nothing to show — redirect home.
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
