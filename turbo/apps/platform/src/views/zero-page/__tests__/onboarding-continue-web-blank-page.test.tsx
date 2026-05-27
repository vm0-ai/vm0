import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

function mockAdminOnboardingDeferred() {
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
    mockApi(onboardingSetupContract.setup, ({ respond }) => {
      return respond(200, { agentId: MOCK_AGENT_ID });
    }),
  );
}

describe("onboarding Pro trial checkout loading", () => {
  it("should show loading after clicking Get Started while checkout is pending", async () => {
    mockAdminOnboardingDeferred();
    const checkoutDeferred = createDeferredPromise<void>(context.signal);
    let checkoutBody: Record<string, unknown> | null = null;
    let checkoutCompleted = false;
    server.use(
      mockApi(zeroBillingCheckoutContract.create, async ({ body, respond }) => {
        checkoutBody = body as Record<string, unknown>;
        await checkoutDeferred.promise;
        checkoutCompleted = true;
        return respond(200, {
          url: "https://checkout.stripe.com/test?mode=trial",
        });
      }),
    );

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
      expect(screen.getByText("Next")).toBeInTheDocument();
    });
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-trial")).toBeInTheDocument();
    });

    click(screen.getByText(/Get Started/));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-next-button")).toHaveAttribute(
        "aria-busy",
        "true",
      );
    });
    expect(checkoutBody).toMatchObject({ tier: "pro", trialDays: 7 });

    checkoutDeferred.resolve();
    await waitFor(() => {
      expect(checkoutCompleted).toBeTruthy();
    });
  });
});
