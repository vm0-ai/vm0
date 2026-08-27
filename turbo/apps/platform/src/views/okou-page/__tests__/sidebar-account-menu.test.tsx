import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { command } from "ccstate";
import { describe, expect, it, vi } from "vitest";

import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
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
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { foregroundReady$ } from "../../../signals/auth-retry.ts";
import { subscribeRealtimeReadyCatchUp$ } from "../../../signals/realtime.ts";

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

function prepareDefaultAgent(): void {
  context.mocks.data.agents([
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

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
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

async function openAccountMenu(): Promise<HTMLElement> {
  const accountName = await screen.findByText("Alex Rivera");
  const accountButton = accountName.closest("button");
  if (!accountButton) {
    throw new Error("Account menu trigger not found");
  }
  click(accountButton);
  return screen.findByRole("menu");
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

describe("zero sidebar account menu", () => {
  it("restores visible focus to the account trigger when the menu closes", async () => {
    const user = userEvent.setup();
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    const accountName = await screen.findByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Account menu trigger not found");
    }

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

  it("shows realtime recovery status beside the expanded account only in debug mode", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    const accountName = await screen.findByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Account menu trigger not found");
    }
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("threadListChanged"),
      ).toBeTruthy();
      expect(within(accountButton).queryByRole("status")).toBeNull();
    });

    act(() => {
      context.mocks.ably.triggerConnectionState("disconnected", {
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
      context.mocks.ably.triggerConnectionState("connected");
    });
    await waitFor(() => {
      expect(within(accountButton).queryByRole("status")).toBeNull();
    });

    act(() => {
      context.mocks.ably.triggerFailure("terminal connection failure");
    });
    await waitFor(() => {
      expect(
        within(accountButton).getByRole("status", {
          name: "Realtime disconnected",
        }),
      ).toBeInTheDocument();
    });
  });

  it("keeps realtime recovery status hidden when debug mode is disabled", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    const accountName = await screen.findByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Account menu trigger not found");
    }
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("threadListChanged"),
      ).toBeTruthy();
    });

    act(() => {
      context.mocks.ably.triggerConnectionState("disconnected", {
        retryIn: 5000,
      });
    });
    expect(within(accountButton).queryByRole("status")).toBeNull();
  });

  it("refreshes member usage pack credits without requesting org billing", async () => {
    mockMemberAccountSidebar();
    let usagePackCredits = 20_400;
    let usagePackCreditRequests = 0;
    let billingRequests = 0;
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      billingRequests += 1;
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
      usagePackCreditRequests += 1;
      return respond(200, {
        totalCredits: usagePackCredits,
        purchasedCredits: Math.max(0, usagePackCredits - 400),
        bonusCredits: 400,
        creditGrants: [],
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
      expect(billingRequests).toBeGreaterThan(0);
    });
    billingRequests = 0;
    const menu = await openAccountMenu();
    const usagePackItem = await within(menu).findByTestId(
      "account-menu-credit-balance",
    );
    expect(
      within(usagePackItem).getByText("20,400 credits"),
    ).toBeInTheDocument();
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
    expect(usagePackCreditRequests).toBe(2);
    expect(billingRequests).toBe(0);

    click(refreshedUsagePackItem);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Credit balance" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("usage-pack-credit-card")).toBeInTheDocument();
    });
  });

  it("shows admins one total combining organization and personal usage pack credits", async () => {
    mockAdminAccountSidebar();
    context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
      return respond(200, {
        totalCredits: 20_400,
        purchasedCredits: 20_000,
        bonusCredits: 400,
        creditGrants: [],
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
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

  it("opens credit balance and export data from the account menu", async () => {
    mockAdminAccountSidebar();
    const openMock = context.mocks.browser.open(null);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    let menu = await openAccountMenu();

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

    menu = await openAccountMenu();
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

  it("refreshes the org credit balance when the menu opens", async () => {
    mockAdminAccountSidebar();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    let menu = await openAccountMenu();
    await waitFor(() => {
      expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
    });

    // The org spends credits elsewhere; the next menu open must reflect it.
    mockAdminBillingStatus(500);

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    menu = await openAccountMenu();
    await waitFor(() => {
      expect(within(menu).getByText("500 credits")).toBeInTheDocument();
    });
    expect(within(menu).queryByText("12,500 credits")).not.toBeInTheDocument();
  });

  it("shares foreground indicator and billing refreshes with the account menu", async () => {
    let billingRequests = 0;
    let indicatorRequests = 0;
    mockAdminAccountSidebar();
    mockAdminBillingStatus(12_500, {
      onRequest: () => {
        billingRequests += 1;
      },
    });
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      indicatorRequests += 1;
      return respond(200, { agents: {}, threads: {} });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
      expect(
        context.mocks.ably.hasSubscription("threadListChanged"),
      ).toBeTruthy();
      expect(
        context.mocks.ably.hasSubscription("chatThreadReadCursorUpdated"),
      ).toBeTruthy();
      expect(billingRequests).toBeGreaterThan(0);
      expect(indicatorRequests).toBeGreaterThan(0);
    });

    let previousIndicatorRequests = indicatorRequests;
    context.mocks.ably.trigger("threadListChanged");
    await waitFor(() => {
      expect(indicatorRequests).toBe(previousIndicatorRequests + 1);
    });
    previousIndicatorRequests = indicatorRequests;
    context.mocks.ably.trigger("chatThreadReadCursorUpdated");
    await waitFor(() => {
      expect(indicatorRequests).toBe(previousIndicatorRequests + 1);
    });

    mockAdminBillingStatus(500, {
      onRequest: () => {
        billingRequests += 1;
      },
    });
    billingRequests = 0;
    indicatorRequests = 0;

    const accountName = screen.getByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Expected account menu trigger");
    }
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(accountButton);
    let menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(within(menu).getByText("500 credits")).toBeInTheDocument();
      expect(billingRequests).toBe(1);
      expect(indicatorRequests).toBe(1);
    });
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    mockAdminBillingStatus(250, {
      onRequest: () => {
        billingRequests += 1;
      },
    });
    billingRequests = 0;

    menu = await openAccountMenu();
    await waitFor(() => {
      expect(within(menu).getByText("250 credits")).toBeInTheDocument();
      expect(billingRequests).toBe(1);
    });

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    billingRequests = 0;
    mockAdminBillingStatus(125, {
      failFirstRequest: true,
      onRequest: () => {
        billingRequests += 1;
      },
    });

    window.dispatchEvent(new Event("focus"));
    fireEvent.click(accountButton);
    menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(within(menu).getByText("125 credits")).toBeInTheDocument();
      expect(billingRequests).toBe(2);
    });
  });

  it("joins a foreground billing refresh that already started", async () => {
    let billingRequests = 0;
    mockAdminAccountSidebar();
    mockAdminBillingStatus(12_500, {
      onRequest: () => {
        billingRequests += 1;
      },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
      expect(billingRequests).toBeGreaterThan(0);
    });

    const initialMenu = await openAccountMenu();
    await waitFor(() => {
      expect(
        within(initialMenu).getByText("12,500 credits"),
      ).toBeInTheDocument();
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    const catchUpCanFinish = context.mocks.deferred<void>();
    const holdForegroundCatchUp$ = command(
      async (_ctx, signal: AbortSignal): Promise<void> => {
        await catchUpCanFinish.promise;
        signal.throwIfAborted();
      },
    );
    context.store.set(
      subscribeRealtimeReadyCatchUp$,
      holdForegroundCatchUp$,
      context.signal,
    );

    mockAdminBillingStatus(500, {
      onRequest: () => {
        billingRequests += 1;
      },
    });
    billingRequests = 0;

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(billingRequests).toBe(1);
    });
    const foregroundReady = context.store.get(foregroundReady$);
    expect(foregroundReady.pending).toBeTruthy();

    const menu = await openAccountMenu();
    expect(billingRequests).toBe(1);

    catchUpCanFinish.resolve();
    await foregroundReady.promise;
    await waitFor(() => {
      expect(within(menu).getByText("500 credits")).toBeInTheDocument();
      expect(billingRequests).toBe(1);
    });
  });

  it("joins a foreground billing request after the catch-up barrier settles", async () => {
    let billingRequests = 0;
    mockAdminAccountSidebar();
    mockAdminBillingStatus(12_500, {
      onRequest: () => {
        billingRequests += 1;
      },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
      expect(billingRequests).toBeGreaterThan(0);
    });

    const initialMenu = await openAccountMenu();
    await waitFor(() => {
      expect(
        within(initialMenu).getByText("12,500 credits"),
      ).toBeInTheDocument();
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    const foregroundRequestStarted = context.mocks.deferred<void>();
    const foregroundResponseReady = context.mocks.deferred<void>();
    mockAdminBillingStatus(500, {
      firstRequestGate: {
        onStarted: () => {
          foregroundRequestStarted.resolve();
        },
        waitUntil: foregroundResponseReady.promise,
      },
      onRequest: () => {
        billingRequests += 1;
      },
    });
    billingRequests = 0;

    window.dispatchEvent(new Event("focus"));
    await foregroundRequestStarted.promise;
    await waitFor(() => {
      expect(context.store.get(foregroundReady$).pending).toBeFalsy();
    });

    const menu = await openAccountMenu();
    foregroundResponseReady.resolve();
    await waitFor(() => {
      expect(within(menu).getByText("500 credits")).toBeInTheDocument();
      expect(billingRequests).toBe(1);
    });
  });

  it("defers minimal-layout billing refresh until the account menu opens", async () => {
    let billingRequests = 0;
    mockAdminAccountSidebar();
    mockAdminBillingStatus(500, {
      onRequest: () => {
        billingRequests += 1;
      },
    });

    detachedSetupPage({
      context,
      path: `/connectors/github/connect?agentId=${AGENT_ID}`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await screen.findByText("Zero needs GitHub to proceed");
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });
    expect(billingRequests).toBe(0);

    window.dispatchEvent(new Event("focus"));
    const foregroundReady = context.store.get(foregroundReady$);
    await foregroundReady.promise;
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
    expect(billingRequests).toBe(0);

    const menu = await openAccountMenu();
    await waitFor(() => {
      expect(within(menu).getByText("500 credits")).toBeInTheDocument();
      expect(billingRequests).toBe(1);
    });
  });

  it("hides account menu subscriptions when the feature switch is disabled", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
      connectedPersonalClaudeCodeProvider(),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
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

  it("shows subscription usage grouped below credits in the account menu", async () => {
    mockBrowserTimeZone("America/New_York");
    mockNow(context.signal, new Date("2030-01-01T00:48:00.000Z"));
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
      connectedPersonalClaudeCodeProvider(),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
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
    expect(within(panel).getByText("2 resets left")).toBeInTheDocument();
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

    const credits = within(menu).getByText("12,500 credits");
    const codex = within(panel).getByRole("heading", { name: "Codex" });
    expect(
      credits.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("resets Codex usage from the account menu", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);
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

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
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
    expect(
      within(confirmDialog).getByText(/2 resets left/),
    ).toBeInTheDocument();
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

  it("refreshes account menu subscriptions when the menu opens", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
      connectedPersonalClaudeCodeProvider(),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    let menu = await openAccountMenu();
    let panel = await within(menu).findByTestId("account-menu-subscriptions");
    expect(within(panel).getByText("82%")).toBeInTheDocument();

    context.mocks.data.personalModelProviders([
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
    ]);

    expect(within(panel).queryByText("64%")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    menu = await openAccountMenu();
    panel = await within(menu).findByTestId("account-menu-subscriptions");

    await waitFor(() => {
      expect(within(panel).getByText("64%")).toBeInTheDocument();
      expect(within(panel).getByText("30%")).toBeInTheDocument();
    });
  });

  it("keeps loaded subscription usage visible while a menu refresh is pending", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    let menu = await openAccountMenu();
    let panel = await within(menu).findByTestId("account-menu-subscriptions");
    expect(
      within(panel).getByRole("heading", { name: "Codex" }),
    ).toBeInTheDocument();
    expect(within(panel).getByText("82%")).toBeInTheDocument();
    expect(
      within(panel).queryByRole("heading", { name: "Claude Code" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    const refreshReady = context.mocks.deferred<void>();
    let refreshRequested = false;
    context.mocks.api(
      personalModelProvidersMainContract.list,
      async ({ respond }) => {
        refreshRequested = true;
        await refreshReady.promise;
        return respond(200, { modelProviders: [] });
      },
    );

    menu = await openAccountMenu();
    panel = await within(menu).findByTestId("account-menu-subscriptions");

    await waitFor(() => {
      expect(refreshRequested).toBeTruthy();
    });
    expect(
      within(panel).getByRole("heading", { name: "Codex" }),
    ).toBeInTheDocument();
    expect(within(panel).getByText("82%")).toBeInTheDocument();
    expect(
      within(panel).queryByRole("heading", { name: "Claude Code" }),
    ).not.toBeInTheDocument();

    refreshReady.resolve();

    await waitFor(() => {
      expect(
        within(menu).queryByTestId("account-menu-subscriptions"),
      ).not.toBeInTheDocument();
    });
  });

  it("links to the hosted user profile in a new tab and changes debug capture", async () => {
    prepareDefaultAgent();
    context.mocks.data.userPreferences({
      captureNetworkBodiesRemaining: 0,
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Open chat list menu")).toBeInTheDocument();
    });
    const accountName = await screen.findByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Account menu trigger not found");
    }

    click(accountButton);

    const menu = await screen.findByRole("menu");
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
      expect(
        within(dialog).getByText("Account & Security"),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
      expect(
        within(dialog).getByText("alex.rivera@example.test"),
      ).toBeInTheDocument();
    });

    const openedSettingsDialog = screen.getByRole("dialog", {
      name: "Settings",
    });
    await waitFor(() => {
      const activeElement = document.activeElement;
      expect(openedSettingsDialog).not.toHaveFocus();
      expect(activeElement).toBeInstanceOf(HTMLElement);
      expect(openedSettingsDialog).toContainElement(
        activeElement as HTMLElement,
      );
    });

    const userProfileLink = linkByText("Manage");
    expect(userProfileLink).toHaveAttribute(
      "href",
      "https://accounts.example.test/user",
    );
    expect(userProfileLink).toHaveAttribute("target", "_blank");
    expect(userProfileLink).toHaveAttribute("rel", "noreferrer");
    expect(mockedClerk.buildUserProfileUrl).toHaveBeenCalledWith();
    expect(mockedClerk.buildUrlWithAuth).toHaveBeenCalledWith(
      "https://accounts.example.test/user",
    );

    click(buttonByText("Debug"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Debug" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(
        screen.getByText("Enabled for the next 3 runs"),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });

    const settingsDialog = screen.getByRole("dialog", { name: "Settings" });
    click(buttonByLabel("Close", settingsDialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).not.toBeInTheDocument();
      expect(document.querySelector(".zero-dialog-overlay")).toBeNull();
    });
    expect(document.body.style.pointerEvents).not.toBe("none");

    const reopenedMenu = await openAccountMenu();
    expect(within(reopenedMenu).getByText("Settings")).toBeInTheDocument();
  });

  it("links the production satellite to the primary hosted user profile", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    const menu = await openAccountMenu();
    click(within(menu).getByText("Settings"));

    await screen.findByRole("dialog", { name: "Settings" });
    expect(linkByText("Manage")).toHaveAttribute(
      "href",
      "https://accounts.vm0.ai/user",
    );
  });

  it("hides debug settings when OkouDebug is disabled", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat?settings=debug`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(dialog).getByRole("heading", { name: "Preference" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Debug")).not.toBeInTheDocument();
  });

  it("restores page interactivity after closing settings", async () => {
    prepareDefaultAgent();
    const user = userEvent.setup({ delay: null });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Open chat list menu")).toBeInTheDocument();
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

    expect(document.querySelector(".zero-dialog-overlay")).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");

    await user.click(screen.getByLabelText("Open chat list menu"));
    await expect(screen.findByRole("menu")).resolves.toBeInTheDocument();
  });

  it("shows account switching, add-account, and sign-out actions", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
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
    });

    let menu = await openAccountMenu();
    click(within(menu).getByText("Switch account"));

    await waitFor(() => {
      expect(screen.getByText("Jamie Chen")).toBeInTheDocument();
      expect(screen.getByText("jamie.chen@example.test")).toBeInTheDocument();
      expect(screen.getByText("Add account")).toBeInTheDocument();
    });

    click(screen.getByText("Add account"));
    await waitFor(() => {
      expect(mockedClerk.openSignIn).toHaveBeenCalledWith({
        fallbackRedirectUrl: "/",
        forceRedirectUrl: "/",
      });
    });

    menu = await openAccountMenu();
    click(within(menu).getByText("Switch account"));
    click(await screen.findByText("Jamie Chen"));

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith(
        expect.objectContaining({ session: "session-jamie" }),
      );
    });

    menu = await openAccountMenu();
    click(within(menu).getByText("Sign out"));

    await waitFor(() => {
      expect(mockedClerk.signOut).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "test-session-id",
          redirectUrl: expect.stringMatching(/\/sign-in\?.*redirect_url=/),
        }),
      );
    });
  });

  it("opens the custom v2 add-account dialog at identifier entry", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.AuthV2AddAccount]: true },
    });

    const menu = await openAccountMenu();
    const originalUrl = window.location.href;
    click(within(menu).getByText("Add account"));

    const dialog = await screen.findByTestId("auth-v2-add-account-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(within(dialog).getByTestId("app-auth-v2")).toBeVisible();
    await expect(
      within(dialog).findByLabelText("Email address"),
    ).resolves.toBeVisible();
    expect(window.location.href).toBe(originalUrl);
    expect(mockedClerk.openSignIn).not.toHaveBeenCalled();

    click(buttonByLabel("Close", dialog));
    await waitFor(() => {
      expect(
        screen.queryByTestId("auth-v2-add-account-dialog"),
      ).not.toBeInTheDocument();
    });
    expect(window.location.href).toBe(originalUrl);
  });

  it("preserves satellite session sync after signing out", async () => {
    prepareDefaultAgent();
    context.mocks.browser.url("https://app.okou.ai/");

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    const menu = await openAccountMenu();
    click(within(menu).getByText("Sign out"));

    await waitFor(() => {
      expect(mockedClerk.signOut).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "test-session-id",
          redirectUrl: expect.stringMatching(/__clerk_synced%3Dfalse/),
        }),
      );
    });
  });

  it("keeps an active session open when the replay remains unauthorized", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);

    let modelProviderRequests = 0;
    context.mocks.api(
      personalModelProvidersMainContract.list,
      ({ respond }) => {
        modelProviderRequests += 1;
        return respond(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "Unauthorized",
          },
        });
      },
    );
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      return Promise.resolve(options?.skipCache ? "fresh-token" : "test-token");
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    await waitFor(() => {
      expect(modelProviderRequests).toBe(2);
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
    expect(screen.queryByText("Unauthorized")).not.toBeInTheDocument();
  });

  it("keeps the app open when auth recovery remains unauthorized in the background", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    let modelProviderRequests = 0;
    context.mocks.api(
      personalModelProvidersMainContract.list,
      ({ respond }) => {
        modelProviderRequests += 1;
        return respond(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "Unauthorized",
          },
        });
      },
    );
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      return Promise.resolve(options?.skipCache ? "fresh-token" : "test-token");
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    await waitFor(() => {
      expect(modelProviderRequests).toBe(2);
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
    expect(screen.queryByText("Unauthorized")).not.toBeInTheDocument();
  });

  it("localizes account actions without changing account data or routes", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });
    const openMock = context.mocks.browser.open(null);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
        clientSessions: [
          {
            id: "test-session-id",
            status: "active",
            user: {
              fullName: "Alex Rivera",
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
              primaryEmailAddress: {
                emailAddress: "jamie.chen@example.test",
              },
            },
          },
        ],
      },
      featureSwitches: {
        [FeatureSwitchKey.SidebarSubscriptionUsage]: true,
      },
    });

    let menu = await openAccountMenu();
    expect(within(menu).getByText("Alex Rivera")).toBeVisible();
    expect(within(menu).getByText("alex.rivera@example.test")).toBeVisible();
    expect(within(menu).getByText("Configurações")).toBeVisible();
    expect(within(menu).getByText("Trocar de conta")).toBeVisible();
    expect(within(menu).getByText("Exportar dados")).toBeVisible();
    expect(within(menu).getByText("Sair")).toBeVisible();
    expect(within(menu).getByText("12.500 créditos")).toBeVisible();
    const subscriptions = await within(menu).findByTestId(
      "account-menu-subscriptions",
    );
    expect(
      within(subscriptions).getByText("2 redefinições restantes"),
    ).toBeVisible();
    expect(
      within(subscriptions).getByRole("progressbar", {
        name: "Codex: 5h restante",
      }),
    ).toHaveAttribute("aria-valuenow", "82");
    expect(within(subscriptions).getByText("Redefinir")).toBeInTheDocument();

    click(within(menu).getByText("Exportar dados"));
    await waitFor(() => {
      expect(
        openMock.calls.some((call) => {
          return call.url?.endsWith("/export") ?? false;
        }),
      ).toBeTruthy();
    });

    menu = await openAccountMenu();
    click(within(menu).getByText("Trocar de conta"));
    await waitFor(() => {
      const menuItems = queryAllByRoleFast("menuitem");
      const switchAccount = menuItems.find((item) => {
        return (
          item.textContent?.includes("Jamie Chen") === true &&
          item.textContent.includes("jamie.chen@example.test")
        );
      });
      if (!switchAccount) {
        throw new Error("Expected the account switch menu item");
      }
      expect(within(switchAccount).getByText("Jamie Chen")).toBeVisible();
      expect(
        within(switchAccount).getByText("jamie.chen@example.test"),
      ).toBeVisible();
      const addAccount = menuItems.find((item) => {
        return item.textContent === "Adicionar conta";
      });
      expect(addAccount).toBeVisible();
    });
  });
});
