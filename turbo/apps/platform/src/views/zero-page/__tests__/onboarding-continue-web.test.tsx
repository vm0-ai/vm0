import {
  onboardingSetupContract,
  onboardingStatusContract,
} from "@vm0/api-contracts/contracts/onboarding";
import {
  zeroBillingCheckoutContract,
  zeroBillingRedeemCodeContract,
  zeroBillingStatusContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroConnectorOauthStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

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

function mockCompletedUseCaseOnboarding(): void {
  context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: MOCK_AGENT_ID,
      defaultAgentMetadata: {
        displayName: "Zero",
      },
    });
  });
}

function mockUseCaseWithoutDefaultAgent(): void {
  context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
}

function connectorResponse(type: ConnectorType): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "oauth",
    externalId: `${type}-external-id`,
    externalUsername: `${type}-user`,
    externalEmail: null,
    oauthScopes: ["read"],
    connectionStatus: "connected",
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function connectorRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest(".zero-border");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${label} connector row not found`);
  }
  return row;
}

function createMockAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  return authWindow;
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

  it("seeds prompt-only onboarding into the try-it composer and starts admin trial checkout", async () => {
    mockAdminOnboarding();
    const checkoutBodies: Record<string, unknown>[] = [];
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        checkoutBodies.push(body as Record<string, unknown>);
        return respond(200, {
          url: "https://checkout.stripe.com/test?mode=use-case-trial",
        });
      },
    );

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
      expect(screen.getByTestId("onboarding-next-button")).toHaveTextContent(
        "Try It",
      );
    });

    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(checkoutBodies[0]).toMatchObject({
        tier: "pro",
        trialDays: 7,
      });
    });
  });

  it("shows preselected use-case connectors and connects a missing one", async () => {
    mockAdminOnboarding();
    const slackConnector = connectorResponse("slack");
    const githubConnector = connectorResponse("github");
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.data.connectors([slackConnector]);
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        return respond(200, {
          authorizationUrl: `https://oauth.test/${params.type}/authorize`,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=Summarize%20customer%20feedback&connector=slack,github",
    });

    await fill(await screen.findByPlaceholderText("e.g. Acme Corp"), "Acme");
    click(screen.getByTestId("onboarding-role-founder"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-next-button")).not.toBeDisabled();
    });
    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(screen.getByText("Try this prompt")).toBeInTheDocument();
      expect(screen.getByTestId("onboarding-prompt-input")).toHaveValue(
        "Summarize customer feedback",
      );
      expect(
        within(connectorRow("Slack")).getByText("Connected"),
      ).toBeInTheDocument();
      expect(
        within(connectorRow("GitHub")).getByText("Connect"),
      ).toBeInTheDocument();
    });

    await fill(
      screen.getByTestId("onboarding-prompt-input"),
      "Summarize customer feedback every Friday",
    );
    expect(screen.getByTestId("onboarding-prompt-input")).toHaveValue(
      "Summarize customer feedback every Friday",
    );

    click(within(connectorRow("GitHub")).getByText("Connect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
      expect(
        context.mocks.ably.hasSubscription("connector:changed"),
      ).toBeTruthy();
    });

    context.mocks.data.connectors([slackConnector, githubConnector]);
    context.mocks.ably.trigger("connector:changed");

    await waitFor(() => {
      expect(
        within(connectorRow("GitHub")).getByText("Connected"),
      ).toBeInTheDocument();
    });
  });

  it("continues prompt onboarding into a seeded chat", async () => {
    mockCompletedUseCaseOnboarding();
    mockChatLifecycle(context, {
      threadId: "thread-onboarding-use-case",
    });

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=Build%20a%20launch%20recap",
    });

    await waitFor(() => {
      expect(screen.getByText("Try this prompt")).toBeInTheDocument();
      expect(screen.getByTestId("onboarding-prompt-input")).toHaveValue(
        "Build a launch recap",
      );
    });

    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(screen.getByText("Build a launch recap")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("keeps a use-case flow on the page when no default agent resolves", async () => {
    mockUseCaseWithoutDefaultAgent();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=Build%20a%20launch%20recap",
    });

    await waitFor(() => {
      expect(screen.getByText("Try this prompt")).toBeInTheDocument();
      expect(screen.getByTestId("onboarding-prompt-input")).toHaveValue(
        "Build a launch recap",
      );
    });

    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(
        screen.getByText(
          /Onboarding could not resolve a default agent\. Please retry\./u,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Try this prompt")).toBeInTheDocument();
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

  it("finishes regular onboarding directly when trial checkout is not pending", async () => {
    mockAdminOnboarding();
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "free",
        credits: 0,
        onboardingPaymentPending: false,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: false,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
        creditBreakdown: [],
        creditGrants: [],
      });
    });
    mockChatLifecycle(context, {
      threadId: "thread-onboarding-no-trial",
    });

    detachedSetupPage({ context, path: "/onboarding" });

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
    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("onboarding-step-trial")).toBeNull();
      expect(
        screen.getByPlaceholderText(
          "Ask me to automate workflows, manage tasks...",
        ),
      ).toBeInTheDocument();
    });
  });

  it("waits for a redeemed onboarding code before continuing to the default agent", async () => {
    let redeemReady = false;
    context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
      if (redeemReady) {
        return respond(200, {
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: { displayName: "Zero" },
        });
      }
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
    context.mocks.api(
      zeroBillingRedeemCodeContract.create,
      ({ body, respond }) => {
        expect(body).toStrictEqual({ code: "YUMA-READY" });
        return respond(200, {
          redeemed: true,
        });
      },
    );
    mockChatLifecycle(context, {
      threadId: "thread-onboarding-redeemed",
    });

    detachedSetupPage({
      context,
      path: "/onboarding?redeemCode=YUMA-READY",
    });

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
    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });

    redeemReady = true;
    context.mocks.ably.trigger("billing:changed");

    await waitFor(() => {
      expect(screen.getByText("Redeem code applied")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(
          "Ask me to automate workflows, manage tasks...",
        ),
      ).toBeInTheDocument();
    });
  });
});
