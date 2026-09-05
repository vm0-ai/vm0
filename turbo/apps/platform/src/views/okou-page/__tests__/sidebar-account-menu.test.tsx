import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockedClerk,
  mockSignInResource,
} from "../../../__tests__/mock-auth.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
function connectedPersonalCodexProvider(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000301",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    workspaceName: "Personal ChatGPT",
    planType: "pro",
    accountEmail: "codex.user@example.com",
    subscriptionResetPeriod: "Weekly",
    subscriptionNextResetAt: "2030-01-07T00:00:00.000Z",
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 18,
        remainingPercent: 82,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 45,
        remainingPercent: 55,
        resetAt: "2030-01-07T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    },
    subscriptionResetCredits: 2,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
    ...overrides,
  };
}

function connectedPersonalClaudeCodeProvider(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000302",
    type: "claude-code-oauth-token",
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    workspaceName: "claude.user@example.com",
    planType: "pro",
    subscriptionResetPeriod: "weekly",
    subscriptionNextResetAt: "2030-01-07T00:00:00.000Z",
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 12,
        remainingPercent: 88,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 24,
        remainingPercent: 76,
        resetAt: "2030-01-07T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
    ...overrides,
  };
}

function prepareDefaultAgent(targetContext = context): void {
  targetContext.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function linkByText(text: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

function buttonByLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected element to be inside a form");
  }
  return form;
}

function formatResetInTimeZone(resetAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(resetAt));
}

function mockBrowserTimeZone(timeZone: string): void {
  const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolvedOptions,
    timeZone,
  });
}

function expectVisibleText(text: string): void {
  const matches = screen.getAllByText(text);
  const visibleMatch = matches.find((element) => {
    try {
      expect(element).toBeVisible();
      return true;
    } catch {
      return false;
    }
  });
  expect(visibleMatch).toBeDefined();
}

function accountMenuTrigger(userName = "Alex Rivera"): HTMLElement {
  const rail = screen.queryByTestId("labeled-nav-rail");
  if (rail) {
    return within(rail).getByLabelText(userName);
  }

  const minimalSidebar = document.querySelector(
    "aside.okou-nav:not(.okou-nav-rail)",
  );
  if (!(minimalSidebar instanceof HTMLElement)) {
    throw new Error("Account menu container not found");
  }
  const accountName = within(minimalSidebar).getByText(userName);
  const button = accountName.closest("button");
  if (!button) {
    throw new Error("Account menu trigger not found");
  }
  return button;
}

function findAccountMenuTrigger(
  userName = "Alex Rivera",
): Promise<HTMLElement> {
  return waitFor(() => {
    return accountMenuTrigger(userName);
  });
}

async function openAccountMenu(): Promise<HTMLElement> {
  const accountButton = await findAccountMenuTrigger();
  click(accountButton);
  return screen.findByRole("menu");
}

function setupAddAccountPage(): Promise<void> {
  prepareDefaultAgent();
  return setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });
}

async function openAuthV2AddAccountDialog(): Promise<HTMLElement> {
  const menu = await openAccountMenu();
  click(within(menu).getByText("Add account"));
  return screen.findByTestId("auth-v2-add-account-dialog");
}

interface MockAdminBillingStatusOptions {
  readonly failFirstRequest?: boolean;
  readonly firstRequestGate?: {
    readonly onStarted: () => void;
    readonly waitUntil: Promise<void>;
  };
  readonly onRequest?: () => void;
}

function mockAdminBillingStatus(
  credits: number,
  options: MockAdminBillingStatusOptions = {},
): void {
  let requestCount = 0;
  context.mocks.api(
    billingStatusContract.get,
    async ({ respond, withSignal }) => {
      requestCount += 1;
      options.onRequest?.();
      if (requestCount === 1 && options.firstRequestGate) {
        options.firstRequestGate.onStarted();
        await withSignal(options.firstRequestGate.waitUntil);
      }
      if (options.failFirstRequest && requestCount === 1) {
        return respond(500, {
          error: {
            message: "Failed to load billing status",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }
      return respond(200, {
        tier: "pro",
        credits,
        onboardingPaymentPending: false,
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: true,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [
          {
            category: "plan",
            tier: "pro",
            label: "Pro credits",
            credits: 10_000,
          },
          {
            category: "promotional",
            label: "Launch bonus",
            credits: 2500,
          },
        ],
        creditGrants: [],
        concurrencyLimit: 0,
        concurrencySubscriptions: [],
      });
    },
  );
}

function mockAdminAccountSidebar(): void {
  prepareDefaultAgent();
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockAdminBillingStatus(12_500);
}

function mockMemberAccountSidebar(): void {
  prepareDefaultAgent();
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
}

test("Return keyboard focus after closing the account menu", async () => {
  const user = userEvent.setup();
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const accountButton = await findAccountMenuTrigger();

  await user.click(accountButton);
  const menu = await screen.findByRole("menu");
  expect(menu).toBeInTheDocument();

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(accountButton).toHaveFocus();
    expect(accountButton.matches(":focus-visible")).toBeTruthy();
  });
});

test("Show realtime recovery status only in Debug mode", async () => {
  context.mocks.browser.matchMedia(false);
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  click(await screen.findByLabelText("Open menu"));
  const accountButton = await findAccountMenuTrigger();
  await waitFor(() => {
    expect(accountButton.closest("aside")).toHaveAttribute(
      "data-sidebar-expanded",
      "true",
    );
    expect(within(accountButton).queryByRole("status")).toBeNull();
    expect(
      context.mocks.ably.hasChannelSubscriptionOnChannel(
        "user-org:test-user-123:org_default",
      ),
    ).toBeTruthy();
  });

  act(() => {
    context.mocks.ably.triggerSharedWorkerConnectionState("disconnected", {
      retryIn: 5000,
    });
  });
  await waitFor(() => {
    expect(
      within(accountButton).getByRole("status", {
        name: "Realtime reconnecting",
      }),
    ).toBeInTheDocument();
  });

  act(() => {
    context.mocks.ably.triggerSharedWorkerConnectionState("connected");
  });
  await waitFor(() => {
    expect(within(accountButton).queryByRole("status")).toBeNull();
  });

  act(() => {
    context.mocks.ably.triggerSharedWorkerFailure(
      "terminal connection failure",
    );
  });
  await waitFor(() => {
    expect(
      within(accountButton).getByRole("status", {
        name: "Realtime disconnected",
      }),
    ).toBeInTheDocument();
  });
});

test("Hide realtime recovery status outside Debug mode", async () => {
  context.mocks.browser.matchMedia(false);
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  click(await screen.findByLabelText("Open menu"));
  const normalAccountButton = await findAccountMenuTrigger();
  await waitFor(() => {
    expect(normalAccountButton.closest("aside")).toHaveAttribute(
      "data-sidebar-expanded",
      "true",
    );
    expect(
      context.mocks.ably.hasChannelSubscriptionOnChannel(
        "user-org:test-user-123:org_default",
      ),
    ).toBeTruthy();
  });

  act(() => {
    context.mocks.ably.triggerSharedWorkerConnectionState("disconnected", {
      retryIn: 5000,
    });
  });
  await waitFor(() => {
    expect(within(normalAccountButton).queryByRole("status")).toBeNull();
  });

  act(() => {
    context.mocks.ably.triggerSharedWorkerConnectionState("connected");
  });
  await waitFor(() => {
    expect(within(normalAccountButton).queryByRole("status")).toBeNull();
  });

  act(() => {
    context.mocks.ably.triggerSharedWorkerFailure(
      "terminal connection failure",
    );
  });
  await waitFor(() => {
    expect(within(normalAccountButton).queryByRole("status")).toBeNull();
  });
});

test("Show a member’s latest package credits in the account menu", async () => {
  mockMemberAccountSidebar();
  let usagePackCredits = 20_400;
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      credits: 12_500,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    });
  });
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: usagePackCredits,
      purchasedCredits: Math.max(0, usagePackCredits - 400),
      bonusCredits: 400,
      creditGrants: [],
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });
  const menu = await openAccountMenu();
  const usagePackItem = await within(menu).findByTestId(
    "account-menu-credit-balance",
  );
  expect(within(usagePackItem).getByText("20,400 credits")).toBeInTheDocument();
  expect(within(menu).queryByText("32,900 credits")).toBeNull();

  usagePackCredits = 500;
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  const refreshedMenu = await openAccountMenu();
  const refreshedUsagePackItem = await within(refreshedMenu).findByTestId(
    "account-menu-credit-balance",
  );
  await waitFor(() => {
    expect(
      within(refreshedUsagePackItem).getByText("500 credits"),
    ).toBeInTheDocument();
  });

  click(refreshedUsagePackItem);

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Credit balance" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("usage-pack-credit-card")).toBeInTheDocument();
  });
});

test("Combine workspace and member-package credits for administrators", async () => {
  mockAdminAccountSidebar();
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      creditGrants: [],
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();
  const creditItem = await within(menu).findByTestId(
    "account-menu-credit-balance",
  );
  expect(within(creditItem).getByText("32,900 credits")).toBeInTheDocument();
  expect(within(menu).queryByText("12,500 credits")).toBeNull();
  expect(within(menu).queryByText("20,400 credits")).toBeNull();
});

test("Export account data from the account menu", async () => {
  mockAdminAccountSidebar();
  const openMock = context.mocks.browser.open(null);

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();

  await waitFor(() => {
    expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
    expect(within(menu).getByText("Export data")).toBeInTheDocument();
  });

  click(within(menu).getByText("Export data"));

  await waitFor(() => {
    expect(
      openMock.calls.some((call) => {
        return call.url?.endsWith("/export") ?? false;
      }),
    ).toBeTruthy();
  });
});

test("Open workspace Credit balance from the account menu", async () => {
  mockAdminAccountSidebar();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();

  await waitFor(() => {
    expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
  });

  click(within(menu).getByText("12,500 credits"));

  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Credit balance" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("credit-balance-info")).toBeInTheDocument();
    expect(screen.getByText("12,500")).toBeInTheDocument();
  });
});

test("Refresh account balances when the menu opens", async () => {
  mockAdminAccountSidebar();
  mockAdminBillingStatus(12_500);

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  let menu = await openAccountMenu();
  await waitFor(() => {
    expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
  });
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  const refreshRequested = context.mocks.deferred<void>();
  mockAdminBillingStatus(250, {
    onRequest: () => {
      refreshRequested.resolve(undefined);
    },
  });

  menu = await openAccountMenu();
  await refreshRequested.promise;
  await waitFor(() => {
    expect(within(menu).getByText("250 credits")).toBeInTheDocument();
  });
});

test("Hide subscription usage when the account-menu feature is off", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider(),
    connectedPersonalClaudeCodeProvider(),
  ]);

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();

  await waitFor(() => {
    expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
  });
  expect(
    within(menu).queryByTestId("account-menu-subscriptions"),
  ).not.toBeInTheDocument();
});

test("Review personal subscription usage in the account menu", async () => {
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider({
      subscriptionResetCreditsNextExpiresAt: "2030-01-04T00:48:00.000Z",
    }),
    connectedPersonalClaudeCodeProvider(),
  ]);

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  const menu = await openAccountMenu();
  const panel = await within(menu).findByTestId("account-menu-subscriptions");

  expect(within(panel).queryByText("Subscriptions")).not.toBeInTheDocument();
  expect(
    within(panel).queryByLabelText("Refresh subscriptions"),
  ).not.toBeInTheDocument();
  expect(
    within(panel).getByRole("heading", { name: "Codex" }),
  ).toBeInTheDocument();
  expect(
    within(panel).getByRole("heading", { name: "Claude Code" }),
  ).toBeInTheDocument();
  expect(within(panel).getAllByText("5h")).toHaveLength(2);
  expect(within(panel).getAllByText("week")).toHaveLength(2);
  expect(within(panel).getByText("82%")).toBeInTheDocument();
  expect(within(panel).getByText("55%")).toBeInTheDocument();
  expect(within(panel).getByText("88%")).toBeInTheDocument();
  expect(within(panel).getByText("76%")).toBeInTheDocument();
  const resetCredits = within(panel).getByText("2 resets left · expires in 3d");
  expect(resetCredits).toBeInTheDocument();
  expect(within(panel).queryByText(/^resets /)).not.toBeInTheDocument();
  expect(
    within(panel).queryByText(/codex\.user@example\.com/),
  ).not.toBeInTheDocument();

  const codexFiveHour = within(panel).getByRole("progressbar", {
    name: "Codex 5h remaining",
  });
  expect(codexFiveHour).toHaveAttribute("aria-valuenow", "82");
  fireEvent.focus(codexFiveHour);

  await waitFor(() => {
    expectVisibleText("Resets in 4h 12m");
    expectVisibleText(
      formatResetInTimeZone("2030-01-01T05:00:00.000Z", "America/New_York"),
    );
  });
  fireEvent.focus(resetCredits);
  await waitFor(() => {
    expectVisibleText(
      `Soonest reset expires ${formatResetInTimeZone(
        "2030-01-04T00:48:00.000Z",
        "America/New_York",
      )}`,
    );
  });

  const credits = within(menu).getByText("12,500 credits");
  const codex = within(panel).getByRole("heading", { name: "Codex" });
  expect(
    credits.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("Reset Codex usage from the account menu", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([connectedPersonalCodexProvider()]);
  context.mocks.api(
    personalModelProvidersByTypeContract.resetSubscriptionUsage,
    ({ respond }) => {
      const provider = connectedPersonalCodexProvider({
        subscriptionResetCredits: 1,
      });
      context.mocks.data.personalModelProviders([provider]);
      return respond(200, { outcome: "reset" });
    },
  );

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  let menu = await openAccountMenu();
  let panel = await within(menu).findByTestId("account-menu-subscriptions");
  expect(within(panel).getByText("2 resets left")).toBeInTheDocument();
  click(within(panel).getByText("Reset"));

  const confirmDialog = await screen.findByRole("dialog", {
    name: "Reset Codex usage?",
  });
  expect(within(confirmDialog).getByText(/2 resets left/)).toBeInTheDocument();
  const resetButton = queryAllByRoleFast("button", confirmDialog).find(
    (button) => {
      return button.textContent === "Reset usage";
    },
  );
  if (!resetButton) {
    throw new Error("Reset usage button not found");
  }
  click(resetButton);

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Reset Codex usage?" }),
    ).not.toBeInTheDocument();
  });

  menu = await openAccountMenu();
  panel = await within(menu).findByTestId("account-menu-subscriptions");
  expect(within(panel).getByText("1 reset left")).toBeInTheDocument();
});

test("Reuse recent subscription usage, then refresh without blanking it", async () => {
  const openedAt = new Date("2030-01-01T00:48:00.000Z").getTime();
  mockNow(openedAt, context.signal);
  mockAdminAccountSidebar();
  let modelProviders: ModelProviderResponse[] = [
    connectedPersonalCodexProvider(),
    connectedPersonalClaudeCodeProvider(),
  ];
  let requestCount = 0;
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    requestCount += 1;
    return respond(200, { modelProviders });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  let menu = await openAccountMenu();
  let panel = await within(menu).findByTestId("account-menu-subscriptions");
  expect(within(panel).getByText("82%")).toBeInTheDocument();
  const requestsAfterFirstOpen = requestCount;

  modelProviders = [
    connectedPersonalCodexProvider({
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 36,
          remainingPercent: 64,
          resetAt: "2030-01-01T05:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 70,
          remainingPercent: 30,
          resetAt: "2030-01-07T00:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
    }),
    connectedPersonalClaudeCodeProvider(),
  ];

  expect(within(panel).queryByText("64%")).not.toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  mockNow(openedAt + 59_999, context.signal);
  menu = await openAccountMenu();
  panel = await within(menu).findByTestId("account-menu-subscriptions");
  expect(requestCount).toBe(requestsAfterFirstOpen);
  expect(within(panel).getByText("82%")).toBeInTheDocument();
  expect(within(panel).queryByText("64%")).not.toBeInTheDocument();

  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  mockNow(openedAt + 60_000, context.signal);
  menu = await openAccountMenu();
  panel = await within(menu).findByTestId("account-menu-subscriptions");
  await waitFor(() => {
    expect(requestCount).toBe(requestsAfterFirstOpen + 1);
    expect(within(panel).getByText("64%")).toBeInTheDocument();
    expect(within(panel).getByText("30%")).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  const refreshStarted = context.mocks.deferred<void>();
  const refreshReady = context.mocks.deferred<void>();
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond }) => {
      refreshStarted.resolve();
      await refreshReady.promise;
      return respond(200, { modelProviders: [] });
    },
  );

  mockNow(openedAt + 120_000, context.signal);
  menu = await openAccountMenu();
  panel = await within(menu).findByTestId("account-menu-subscriptions");
  await refreshStarted.promise;
  expect(within(panel).getByText("64%")).toBeInTheDocument();
  expect(within(panel).getByText("30%")).toBeInTheDocument();

  refreshReady.resolve();
  await waitFor(() => {
    expect(
      within(menu).queryByTestId("account-menu-subscriptions"),
    ).not.toBeInTheDocument();
  });
});

test("Open personal Settings and manage account security", async () => {
  prepareDefaultAgent();
  context.mocks.data.userPreferences({
    captureNetworkBodiesRemaining: 0,
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.MorningBrief]: true,
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });

  const menu = await openAccountMenu();
  expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(menu).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  click(within(menu).getByText("Settings"));

  await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Preference" }),
    ).toBeInTheDocument();
    // Scoped to the dialog: the sidebar account row also carries the name.
    expect(within(dialog).getByText("Account & Security")).toBeInTheDocument();
    expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(dialog).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();
    const morningBrief = within(dialog).getByTestId("morning-brief-preference");
    expect(morningBrief.previousElementSibling).toContainElement(
      within(dialog).getByText("Time zone"),
    );
    expect(within(dialog).queryByText("Send now")).toBeNull();
  });

  const openedSettingsDialog = screen.getByRole("dialog", {
    name: "Settings",
  });
  await waitFor(() => {
    const activeElement = document.activeElement;
    expect(openedSettingsDialog).not.toHaveFocus();
    expect(activeElement).toBeInstanceOf(HTMLElement);
    expect(openedSettingsDialog).toContainElement(activeElement as HTMLElement);
  });

  const userProfileLink = linkByText("Manage");
  expect(userProfileLink).toHaveAttribute(
    "href",
    "https://accounts.example.test/user",
  );
  expect(userProfileLink).toHaveAttribute("target", "_blank");
  expect(userProfileLink).toHaveAttribute("rel", "noreferrer");
});

test("Open personal Settings and manage account security from the production satellite", async () => {
  prepareDefaultAgent();
  context.mocks.data.userPreferences({
    captureNetworkBodiesRemaining: 0,
  });

  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const satelliteMenu = await openAccountMenu();
  expect(within(satelliteMenu).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(satelliteMenu).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  click(within(satelliteMenu).getByText("Settings"));
  const settingsDialog = await screen.findByRole("dialog", {
    name: "Settings",
  });
  expect(
    screen.getByRole("heading", { name: "Preference" }),
  ).toBeInTheDocument();
  expect(
    within(settingsDialog).getByText("Account & Security"),
  ).toBeInTheDocument();
  expect(within(settingsDialog).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(settingsDialog).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  await waitFor(() => {
    const activeElement = document.activeElement;
    expect(settingsDialog).not.toHaveFocus();
    expect(activeElement).toBeInstanceOf(HTMLElement);
    expect(settingsDialog).toContainElement(activeElement as HTMLElement);
  });

  const satelliteProfileLink = linkByText("Manage");
  expect(satelliteProfileLink).toHaveAttribute(
    "href",
    "https://accounts.vm0.ai/user",
  );
  expect(satelliteProfileLink).toHaveAttribute("target", "_blank");
  expect(satelliteProfileLink).toHaveAttribute("rel", "noreferrer");
});

test("Toggle network-body capture in Debug settings", async () => {
  prepareDefaultAgent();
  context.mocks.data.userPreferences({
    captureNetworkBodiesRemaining: 0,
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const menu = await openAccountMenu();
  expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(menu).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  click(within(menu).getByText("Settings"));

  await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Preference" }),
    ).toBeInTheDocument();
    // Scoped to the dialog: the sidebar account row also carries the name.
    expect(within(dialog).getByText("Account & Security")).toBeInTheDocument();
    expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(dialog).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();
  });

  click(buttonByText("Debug"));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Debug" })).toBeInTheDocument();
    expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  click(screen.getByRole("switch"));

  await waitFor(() => {
    expect(screen.getByText("Enabled for the next 3 runs")).toBeInTheDocument();
  });

  click(screen.getByRole("switch"));

  await waitFor(() => {
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });
});

test("Hide Debug settings without Debug access", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?settings=debug`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    within(dialog).getByRole("heading", { name: "Preference" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText("Debug")).not.toBeInTheDocument();
});

test("Restore page interaction after closing Settings", async () => {
  prepareDefaultAgent();
  const user = userEvent.setup({ delay: null });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();
  click(within(menu).getByText("Settings"));

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(within(dialog).getByLabelText("Close"));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  expect(document.querySelector(".okou-dialog-overlay")).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");

  const chatList = await screen.findByTestId("chat-list-column");
  await user.click(within(chatList).getByLabelText("Open chat list menu"));
  await expect(screen.findByRole("menu")).resolves.toBeInTheDocument();
});

test("Switch to another signed-in account", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
        imageUrl: "https://cdn.vm0.test/users/alex.png",
        clientSessions: [
          {
            id: "test-session-id",
            status: "active",
            user: {
              fullName: "Alex Rivera",
              imageUrl: "https://cdn.vm0.test/users/alex.png",
              primaryEmailAddress: {
                emailAddress: "alex.rivera@example.test",
              },
            },
          },
          {
            id: "session-jamie",
            status: "active",
            user: {
              fullName: "Jamie Chen",
              imageUrl: "https://cdn.vm0.test/users/jamie.png",
              primaryEmailAddress: {
                emailAddress: "jamie.chen@example.test",
              },
            },
          },
        ],
      },
    },
  });

  const menu = await openAccountMenu();
  click(within(menu).getByText("Switch account"));

  await waitFor(() => {
    expect(screen.getByText("Jamie Chen")).toBeInTheDocument();
    expect(screen.getByText("jamie.chen@example.test")).toBeInTheDocument();
  });

  click(await screen.findByText("Jamie Chen"));

  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledWith(
      expect.objectContaining({ session: "session-jamie" }),
    );
  });
});

test("Open Add account without leaving the current page", async () => {
  await setupAddAccountPage();
  const originalUrl = window.location.href;
  const dialog = await openAuthV2AddAccountDialog();
  expect(dialog).toHaveAttribute("role", "dialog");
  expect(within(dialog).getByTestId("app-auth-v2")).toBeVisible();
  await expect(
    within(dialog).findByLabelText("Email address"),
  ).resolves.toBeVisible();
  expect(window.location.href).toBe(originalUrl);

  click(buttonByLabel("Close", dialog));
  await waitFor(() => {
    expect(
      screen.queryByTestId("auth-v2-add-account-dialog"),
    ).not.toBeInTheDocument();
  });
  expect(window.location.href).toBe(originalUrl);
});

test("Continue or restart organization selection while adding an account", async () => {
  await setupAddAccountPage();
  const originalUrl = window.location.href;
  const dialog = await openAuthV2AddAccountDialog();
  const organizationMembership = {
    id: "membership_target",
    organization: {
      id: "org_target",
      imageUrl: null,
      name: "Target Organization",
    },
  };

  mockedClerk.setActive.mockImplementation(async (params) => {
    await params.navigate?.({
      decorateUrl: (url) => {
        return url;
      },
      session: {
        currentTask: { key: "choose-organization" },
        id: "session_pending",
        status: "pending",
        user: { organizationMemberships: [organizationMembership] },
      },
    });
  });

  mockSignInResource({
    status: "needs_first_factor",
    supportedFirstFactors: [{ strategy: "password" }],
  });
  mockedClerk.clientSignInCreate.mockResolvedValue(mockedClerk.client.signIn);
  const identifier = await within(dialog).findByLabelText("Email address");
  fireEvent.change(identifier, {
    target: { value: "second.account@example.test" },
  });
  fireEvent.submit(containingForm(identifier));

  const password = await within(dialog).findByLabelText("Password");
  mockSignInResource({
    createdSessionId: "session_pending",
    status: "complete",
  });
  mockedClerk.signInAttemptFirstFactor.mockResolvedValue(
    mockedClerk.client.signIn,
  );
  fireEvent.change(password, { target: { value: "correct-password" } });
  fireEvent.submit(containingForm(password));

  await expect(
    within(dialog).findByRole("heading", {
      name: "Choose an organization",
    }),
  ).resolves.toBeVisible();
  expect(window.location.href).toBe(originalUrl);

  await waitFor(() => {
    expect(
      buttonByLabel("Continue with Target Organization", dialog),
    ).toBeVisible();
  });
  click(buttonByLabel("Continue with Target Organization", dialog));
  await waitFor(() => {
    expect(buttonByText("Start over", dialog)).toBeVisible();
  });
  expect(window.location.href).toBe(originalUrl);

  click(buttonByText("Start over", dialog));
  await expect(
    within(dialog).findByLabelText("Email address"),
  ).resolves.toBeVisible();
  expect(mockedClerk.signOut).toHaveBeenCalledWith({
    sessionId: "session_pending",
  });
  expect(window.location.href).toBe(originalUrl);
});

test("Cancel an unfinished Add account sign-in", async () => {
  await setupAddAccountPage();
  const originalUrl = window.location.href;
  const dialog = await openAuthV2AddAccountDialog();

  mockSignInResource({
    status: "needs_first_factor",
    supportedFirstFactors: [{ strategy: "password" }],
  });
  mockedClerk.clientSignInCreate.mockResolvedValue(mockedClerk.client.signIn);
  const identifier = await within(dialog).findByLabelText("Email address");
  fireEvent.change(identifier, {
    target: { value: "second.account@example.test" },
  });
  fireEvent.submit(containingForm(identifier));

  const attempt = createDeferredPromise<typeof mockedClerk.client.signIn>(
    context.signal,
  );
  mockedClerk.signInAttemptFirstFactor.mockReturnValue(attempt.promise);
  const password = await within(dialog).findByLabelText("Password");
  fireEvent.change(password, { target: { value: "correct-password" } });
  fireEvent.submit(containingForm(password));
  await waitFor(() => {
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledTimes(1);
  });

  click(buttonByLabel("Close", dialog));
  await waitFor(() => {
    expect(
      screen.queryByTestId("auth-v2-add-account-dialog"),
    ).not.toBeInTheDocument();
  });

  await act(async () => {
    mockSignInResource({
      createdSessionId: "session_after_close",
      status: "complete",
    });
    attempt.resolve(mockedClerk.client.signIn);
    await attempt.promise;
  });
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  expect(window.location.href).toBe(originalUrl);
});

test("Sign out from the account menu", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();
  click(within(menu).getByText("Sign out"));

  await waitFor(() => {
    expect(mockedClerk.signOut).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session-id",
        redirectUrl: expect.stringMatching(
          /(?=.*\/sign-in#\/\?)(?=.*redirect_url=)(?=.*__clerk_synced%3Dfalse)/,
        ),
      }),
    );
  });
});

test("Keep an active session open when background auth recovery fails", async () => {
  mockAdminAccountSidebar();
  context.mocks.data.personalModelProviders([connectedPersonalCodexProvider()]);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      },
    });
  });
  mockedClerk.sessionGetToken.mockImplementation((options) => {
    return Promise.resolve(options?.skipCache ? "fresh-token" : "test-token");
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
  });

  const chatList = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith({
      skipCache: true,
    });
  });
  expect(chatList).toBeInTheDocument();
  expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  expect(screen.queryByText("Unauthorized")).not.toBeInTheDocument();
});
