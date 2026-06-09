import {
  onboardingSetupContract,
  onboardingStatusContract,
} from "@vm0/api-contracts/contracts/onboarding";
import {
  zeroBillingCheckoutContract,
  zeroBillingRedeemCodeContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

function mockAdminOnboarding(): void {
  context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
  context.mocks.api(onboardingSetupContract.setup, ({ respond }) => {
    return respond(200, { agentId: MOCK_AGENT_ID });
  });
}

async function walkAdminToTrial(): Promise<void> {
  await fill(await screen.findByPlaceholderText("e.g. Acme Corp"), "Acme");
  click(screen.getByTestId("onboarding-role-founder"));
  await waitFor(() => {
    expect(screen.getByTestId("onboarding-next-button")).not.toBeDisabled();
  });
  click(screen.getByTestId("onboarding-next-button"));
  await waitFor(() => {
    expect(
      screen.getByTestId("onboarding-step-select-connectors"),
    ).toBeInTheDocument();
  });
  click(screen.getByTestId("connector-card-github"));
  click(screen.getByTestId("onboarding-next-button"));
  await waitFor(() => {
    expect(screen.getByTestId("onboarding-step-trial")).toBeInTheDocument();
  });
}

describe("onboarding web continuation", () => {
  it("starts trial checkout and preserves attribution in checkout URLs", async () => {
    mockAdminOnboarding();
    const checkoutBodies: Record<string, unknown>[] = [];
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        checkoutBodies.push(body as Record<string, unknown>);
        return respond(200, {
          url: "https://checkout.stripe.com/test?mode=trial",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/onboarding?vm0_source=presentation&gclid=test-click&utm_source=google",
    });
    await walkAdminToTrial();

    click(screen.getByText(/Get Started/));

    await waitFor(() => {
      expect(checkoutBodies[0]).toMatchObject({
        tier: "pro",
        trialDays: 7,
      });
    });
    const checkoutBody = checkoutBodies[0];
    if (!checkoutBody) {
      throw new Error("checkout body was not captured");
    }
    const successUrl = new URL(String(checkoutBody.successUrl));
    expect(successUrl.searchParams.get("vm0_source")).toBe("presentation");
    expect(successUrl.searchParams.get("gclid")).toBe("test-click");
    expect(successUrl.searchParams.get("utm_source")).toBe("google");
  });

  it("seeds prompt-only onboarding into the try-it composer", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding?prompt=hello%20world" });

    await fill(await screen.findByPlaceholderText("e.g. Acme Corp"), "Acme");
    click(screen.getByTestId("onboarding-role-founder"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-next-button")).not.toBeDisabled();
    });
    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(screen.getByText("Try this prompt")).toBeInTheDocument();
      expect(screen.getByTestId("onboarding-prompt-input")).toHaveValue(
        "hello world",
      );
    });
  });

  it("keeps failed redemption visible as a toast-only trial-step error", async () => {
    mockAdminOnboarding();
    context.mocks.api(zeroBillingRedeemCodeContract.create, ({ respond }) => {
      return respond(503, {
        error: {
          message: "Redeem service unavailable",
          code: "PROVIDER_UNAVAILABLE",
        },
      });
    });

    detachedSetupPage({
      context,
      path: "/onboarding?redeemCode=YUMA-123",
    });
    await walkAdminToTrial();

    await expect(
      screen.findByText("Redeem service unavailable"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-step-trial")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-redeem-code-form")).toBeNull();
  });
});
