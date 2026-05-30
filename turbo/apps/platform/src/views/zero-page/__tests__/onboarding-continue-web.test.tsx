import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createMockApi } from "../../../mocks/msw-contract.ts";

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

// Step 1 (name workspace) → step 2 (choose tools, pick a connector) → step 4
// (Pro trial). "Get Started" on step 4 starts Stripe checkout.
async function walkAdminToContinue() {
  await waitFor(() => {
    expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await fill(input, "Test Workspace");
  click(screen.getByTestId("onboarding-role-founder"));
  await waitFor(() => {
    expect(screen.getByTestId("onboarding-next-button")).not.toBeDisabled();
  });
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

describe("onboarding Pro trial checkout", () => {
  it("starts Pro trial checkout after admin completes onboarding setup", async () => {
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

  it("preserves ad attribution params through Stripe checkout URLs", async () => {
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

    detachedSetupPage({
      context,
      path: "/onboarding?vm0_source=presentation&gclid=test-click&utm_source=google&utm_medium=cpc&utm_campaign=presentation_search_en",
    });
    await walkAdminToContinue();

    click(screen.getByText(/Get Started/));

    await waitFor(() => {
      expect(checkoutBody).not.toBeNull();
    });

    const successUrl = new URL(String(checkoutBody!.successUrl));
    const cancelUrl = new URL(String(checkoutBody!.cancelUrl));

    expect(successUrl.searchParams.get("billing")).toBe("pro");
    expect(successUrl.searchParams.get("billing_session_id")).toBe(
      "{CHECKOUT_SESSION_ID}",
    );
    expect(cancelUrl.searchParams.get("billing")).toBe("canceled");

    for (const url of [successUrl, cancelUrl]) {
      expect(url.searchParams.get("vm0_source")).toBe("presentation");
      expect(url.searchParams.get("gclid")).toBe("test-click");
      expect(url.searchParams.get("utm_source")).toBe("google");
      expect(url.searchParams.get("utm_medium")).toBe("cpc");
      expect(url.searchParams.get("utm_campaign")).toBe(
        "presentation_search_en",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ?prompt= forwarding
// ---------------------------------------------------------------------------

describe("prompt param forwarding", () => {
  it("?prompt= alone enters use-case mode and seeds the Try It composer", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding?prompt=hello%20world" });

    // Step 1: name workspace. Use-case mode collapses step 2, so the next
    // screen after Next is the condensed step 3 with the editable composer
    // and a "Try It" CTA — not the regular "Choose your tools" picker.
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });
    await fill(screen.getByPlaceholderText("e.g. Acme Corp"), "Test Workspace");
    click(screen.getByTestId("onboarding-role-founder"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-next-button")).not.toBeDisabled();
    });
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByText("Try this prompt")).toBeInTheDocument();
    });
    expect(screen.getByTestId("onboarding-prompt-input")).toHaveValue(
      "hello world",
    );
    expect(screen.getByText("Try It")).toBeInTheDocument();
  });

  it("does not include prompt param in regular checkout URLs when absent", async () => {
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
      expect(checkoutBody).not.toBeNull();
    });

    const successUrl = new URL(String(checkoutBody!.successUrl));
    const cancelUrl = new URL(String(checkoutBody!.cancelUrl));
    expect(successUrl.searchParams.get("prompt")).toBeNull();
    expect(cancelUrl.searchParams.get("prompt")).toBeNull();
  });
});
