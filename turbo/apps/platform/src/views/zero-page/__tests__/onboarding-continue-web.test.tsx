import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
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
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";
import {
  zeroBillingCheckoutContract,
  zeroBillingRedeemCodeContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockRedeemCodeHandler } from "../../../mocks/handlers/api-billing.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import { pathname$ } from "../../../signals/route.ts";

vi.mock("@vm0/ui/components/ui/sonner", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@vm0/ui/components/ui/sonner");
  return {
    ...actual,
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

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

// Step 1 (name workspace) → step 2 (choose tools, pick a connector).
async function walkAdminToTools() {
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
}

// Step 1 (name workspace) → step 2 (choose tools, pick a connector) → step 4
// (Pro trial). "Get Started" on step 4 starts Stripe checkout.
async function walkAdminToContinue() {
  await walkAdminToTools();
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
    let signupAttributionBody: Record<string, unknown> | null = null;
    server.use(
      mockApi(zeroAttributionContract.recordSignup, ({ body, respond }) => {
        signupAttributionBody = body as Record<string, unknown>;
        return respond(200, { recorded: true });
      }),
      mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
        checkoutBody = body as Record<string, unknown>;
        return respond(200, {
          url: "https://checkout.stripe.com/test?mode=trial",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/onboarding?vm0_source=presentation&gclid=test-click&utm_source=google&utm_medium=cpc&utm_campaign=presentation_search_en&vm0_experiment=presentation_lp&vm0_variant=a",
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
      expect(url.searchParams.get("vm0_experiment")).toBe("presentation_lp");
      expect(url.searchParams.get("vm0_variant")).toBe("a");
    }

    expect(checkoutBody!.adAttribution).toStrictEqual({
      vm0_source: "presentation",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "presentation_search_en",
      vm0_experiment: "presentation_lp",
      vm0_variant: "a",
      gclid: "test-click",
      gclid_present: "true",
    });
    await waitFor(() => {
      expect(signupAttributionBody).toStrictEqual({
        attribution: checkoutBody!.adAttribution,
      });
    });
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

    detachedSetupPage({
      context,
      path: "/onboarding",
    });
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

  it("redeems a code and completes onboarding after billing changes", async () => {
    let setupComplete = false;
    let billingComplete = false;
    let redeemedCode: string | null = null;

    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: !billingComplete,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: setupComplete,
          defaultAgentId: setupComplete ? MOCK_AGENT_ID : null,
          defaultAgentMetadata: null,
        });
      }),
      mockApi(onboardingSetupContract.setup, ({ respond }) => {
        setupComplete = true;
        return respond(200, { agentId: MOCK_AGENT_ID });
      }),
    );
    setMockRedeemCodeHandler((code) => {
      redeemedCode = code;
    });

    detachedSetupPage({
      context,
      path: "/onboarding?redeemCode=YUMA-123",
    });
    await walkAdminToTools();
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(redeemedCode).toBe("YUMA-123");
    });
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-next-button")).toHaveAttribute(
        "aria-busy",
        "true",
      );
    });
    await waitFor(() => {
      expect(hasSubscription("billing:changed")).toBeTruthy();
    });

    billingComplete = true;
    triggerAblyEvent("billing:changed");

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe(
        `/agents/${MOCK_AGENT_ID}/chat`,
      );
    });
    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        "Redeem code applied",
      );
    });
  });

  it("redeems a code from a direct trial-step link", async () => {
    let billingComplete = false;
    let redeemedCode: string | null = null;

    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: !billingComplete,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: null,
        });
      }),
    );
    setMockRedeemCodeHandler((code) => {
      redeemedCode = code;
    });

    detachedSetupPage({
      context,
      path: "/onboarding?redeemCode=YUMA-123",
    });

    await waitFor(() => {
      expect(redeemedCode).toBe("YUMA-123");
    });
    await waitFor(() => {
      expect(hasSubscription("billing:changed")).toBeTruthy();
    });

    billingComplete = true;
    triggerAblyEvent("billing:changed");

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe(
        `/agents/${MOCK_AGENT_ID}/chat`,
      );
    });
    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        "Redeem code applied",
      );
    });
  });

  it("shows redeem failures in a toast without inline status copy", async () => {
    mockAdminOnboarding();
    server.use(
      mockApi(zeroBillingRedeemCodeContract.create, ({ respond }) => {
        return respond(503, {
          error: {
            message: "Redeem service unavailable",
            code: "PROVIDER_UNAVAILABLE",
          },
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/onboarding?redeemCode=YUMA-123",
    });
    await walkAdminToContinue();

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Redeem service unavailable",
      );
    });
    expect(screen.getByTestId("onboarding-step-trial")).toBeInTheDocument();
    expect(screen.getByText(/Get Started/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText("Waiting for subscription confirmation..."),
    ).toBeNull();
  });

  it("does not render a redeem code form on the trial step", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding",
    });
    await walkAdminToContinue();

    expect(screen.queryByTestId("onboarding-redeem-code-form")).toBeNull();
  });
});
