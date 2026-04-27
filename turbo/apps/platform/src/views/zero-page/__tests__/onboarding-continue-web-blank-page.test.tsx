import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  onboardingStatusContract,
  onboardingCompleteContract,
} from "@vm0/api-contracts/contracts/onboarding";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

function mockMemberOnboardingDeferred() {
  // Deferred that blocks the POST /complete API response until we release it.
  // This creates a timing window to observe the skeleton while the async
  // onboarding completion is in-flight.
  const completeDeferred = createDeferredPromise<void>(context.signal);

  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MOCK_AGENT_ID,
        defaultAgentMetadata: { displayName: "Zero" },
      });
    }),
    mockApi(onboardingCompleteContract.complete, async ({ respond }) => {
      await completeDeferred.promise;
      return respond(200, { ok: true });
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
    const mock = mockMemberOnboardingDeferred();

    detachedSetupPage({ context, path: "/onboarding" });

    // Member lands on step 2 (Choose your tools) under the unified flow
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    // Advance without selecting a connector — skips step 3, lands on step 4
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // Skeleton should be hidden after onboarding page loaded
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    // Click starts the async onboarding completion; the POST API is deferred
    // so the command is in-flight while we assert skeleton visibility.
    click(screen.getByText(/Continue in web/));

    // Skeleton must be visible during the transition (the fix for #7902)
    await waitFor(() => {
      expect(screen.getByTestId("app-skeleton")).not.toHaveAttribute(
        "aria-hidden",
      );
    });

    // Switch status to complete and add chat-threads mock for the landing page
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: { displayName: "Zero" },
        });
      }),
    );

    // Release the deferred POST response to let onboarding complete and
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
