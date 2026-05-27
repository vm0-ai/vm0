import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

function mockAdminOnboarding() {
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

/** Walk admin onboarding: step 1 → step 2 → step 4. */
async function walkAdminToContinue() {
  await waitFor(() => {
    expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await fill(input, "Test Workspace");
  click(screen.getByText("Next"));

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
}

describe("onboarding → Stripe checkout", () => {
  it("should start Pro trial checkout instead of entering chat directly", async () => {
    mockAdminOnboarding();
    let checkoutBody: Record<string, unknown> | null = null;
    server.use(
      mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
        checkoutBody = body as Record<string, unknown>;
        return respond(200, {
          url: "https://checkout.stripe.com/test?mode=trial",
        });
      }),
    );

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToContinue();

    click(screen.getByText(/Get Started/));

    await waitFor(() => {
      expect(checkoutBody).toMatchObject({ tier: "pro", trialDays: 7 });
    });
  });
});
