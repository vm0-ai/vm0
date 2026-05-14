import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

function mockAdminOnboardingDeferred() {
  // The first setup call (step 1 eager-init) resolves immediately; the second
  // call (step 2 connector authorize, triggered by "Get Started") is
  // deferred so we can observe the skeleton while the command is in-flight.
  const completeDeferred = createDeferredPromise<void>(context.signal);
  let setupCalls = 0;

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
    mockApi(onboardingSetupContract.setup, async ({ respond }) => {
      setupCalls += 1;
      if (setupCalls > 1) {
        await completeDeferred.promise;
      }
      return respond(200, { agentId: MOCK_AGENT_ID });
    }),
  );

  return {
    releaseComplete: () => {
      completeDeferred.resolve();
    },
  };
}

describe("onboarding continue in web → skeleton → chat page (#7902)", () => {
  it("should show skeleton immediately on click, then hide after chat page loads", async () => {
    // Register the onboarding default agent in the team so the chat page setup
    // can find it instead of treating it as missing and redirecting.
    setMockTeam([
      {
        id: MOCK_AGENT_ID,
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    const mock = mockAdminOnboardingDeferred();

    detachedSetupPage({ context, path: "/onboarding" });

    // Step 1: name the workspace and advance (eager-init).
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });
    await fill(screen.getByPlaceholderText("e.g. Acme Corp"), "Test Workspace");
    click(screen.getByText("Next"));

    // Step 2: choose tools — pick a connector so finishing re-runs setup.
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    click(screen.getByTestId("connector-card-github"));

    await waitFor(() => {
      expect(screen.getByText(/Get Started/)).toBeInTheDocument();
    });

    // Skeleton should be hidden after onboarding page loaded
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    // Click starts the async onboarding completion; the setup API is deferred
    // so the command is in-flight while we assert skeleton visibility.
    click(screen.getByText(/Get Started/));

    // Skeleton must be visible during the transition (the fix for #7902)
    await waitFor(() => {
      expect(screen.getByTestId("app-skeleton")).not.toHaveAttribute(
        "aria-hidden",
      );
    });

    // Switch status to complete so the chat page setup doesn't bounce back.
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

    // Release the deferred setup response to let onboarding complete and
    // navigation to the agent chat page proceed.
    mock.releaseComplete();

    // Verify navigation happened to agent chat page
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // Skeleton should be hidden after chat page setup completes
    await waitFor(() => {
      expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    });
  });
});
