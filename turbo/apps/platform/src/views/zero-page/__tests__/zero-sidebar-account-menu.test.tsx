import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { clearMockNow, mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

afterEach(() => {
  clearMockNow();
});

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
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
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

function mockAdminBillingStatus(credits: number): void {
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
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
  });
}

function mockAdminAccountSidebar(): void {
  prepareDefaultAgent();
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
  mockAdminBillingStatus(12_500);
}

describe("zero sidebar account menu", () => {
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
      expect(screen.getByText("Pro credits")).toBeInTheDocument();
      expect(screen.getByText("Launch bonus")).toBeInTheDocument();
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
    mockNow(new Date("2030-01-01T00:48:00.000Z"));
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
      zeroPersonalModelProvidersByTypeContract.resetSubscriptionUsage,
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
      zeroPersonalModelProvidersMainContract.list,
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

  it("keeps the user profile inside settings and changes debug capture", async () => {
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
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
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
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Preference" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Account & Security")).toBeInTheDocument();
      expect(screen.getByText("Alex Rivera")).toBeInTheDocument();
      expect(screen.getByText("alex.rivera@example.test")).toBeInTheDocument();
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

    const clerkProfileModals: HTMLDivElement[] = [];
    mockedClerk.openUserProfile.mockImplementation((options) => {
      const container = options?.getContainer?.();
      if (!container) {
        throw new Error("Clerk profile portal container not found");
      }
      const modal = document.createElement("div");
      modal.dataset.clerkUserProfile = "";
      container.append(modal);
      clerkProfileModals.push(modal);
    });

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(clerkProfileModals).toHaveLength(1);
      expect(mockedClerk.openUserProfile).toHaveBeenCalledWith({
        apiKeysProps: { hide: true },
        getContainer: expect.any(Function),
      });
    });

    const clerkProfileModal = clerkProfileModals[0];
    if (!clerkProfileModal) {
      throw new Error("Clerk profile modal not found");
    }
    expect(openedSettingsDialog).toContainElement(clerkProfileModal);
    clerkProfileModal.remove();

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
    });

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
    mockedClerk.closeUserProfile.mockClear();
    click(buttonByLabel("Close", settingsDialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).not.toBeInTheDocument();
      expect(document.querySelector(".zero-dialog-overlay")).toBeNull();
    });
    expect(mockedClerk.closeUserProfile).toHaveBeenCalledTimes(1);
    expect(document.body.style.pointerEvents).not.toBe("none");

    const reopenedMenu = await openAccountMenu();
    expect(within(reopenedMenu).getByText("Settings")).toBeInTheDocument();
  });

  it("hides debug settings when ZeroDebug is disabled", async () => {
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

  it("retries auth recovery network failures before replaying the request", async () => {
    mockAdminAccountSidebar();
    const provider = connectedPersonalCodexProvider();
    context.mocks.data.personalModelProviders([provider]);

    let modelProviderRequests = 0;
    let forcedTokenRefreshes = 0;
    context.mocks.http.get("*/api/zero/me/model-providers", () => {
      modelProviderRequests += 1;
      if (modelProviderRequests === 1) {
        return HttpResponse.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Unauthorized",
            },
          },
          { status: 401 },
        );
      }
      if (modelProviderRequests === 2) {
        return HttpResponse.error();
      }
      return HttpResponse.json({ modelProviders: [provider] });
    });
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      if (options?.skipCache) {
        forcedTokenRefreshes += 1;
        if (forcedTokenRefreshes === 1) {
          return Promise.reject(
            Object.assign(new Error("Clerk is offline"), {
              code: "clerk_offline",
            }),
          );
        }
        if (forcedTokenRefreshes === 2) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve("fresh-token");
      }
      return Promise.resolve("test-token");
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
      expect(modelProviderRequests).toBe(3);
      expect(forcedTokenRefreshes).toBe(3);
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();

    const menu = await openAccountMenu();
    const panel = await within(menu).findByTestId("account-menu-subscriptions");
    expect(
      within(panel).getByRole("heading", { name: "Codex" }),
    ).toBeInTheDocument();
  });

  it("redirects without a toast when the fresh-token request remains unauthorized", async () => {
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);

    let modelProviderRequests = 0;
    context.mocks.api(
      zeroPersonalModelProvidersMainContract.list,
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
      expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
    });
    expect(screen.queryByText("Unauthorized")).not.toBeInTheDocument();
  });

  it("suppresses global sign-in redirects during add-account auth transitions", async () => {
    mockNow(new Date("2026-01-01T00:00:00.000Z"));
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
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    let menu = await openAccountMenu();
    click(within(menu).getByText("Switch account"));

    await waitFor(() => {
      expect(screen.getByText("Add account")).toBeInTheDocument();
    });

    click(screen.getByText("Add account"));
    await waitFor(() => {
      expect(mockedClerk.openSignIn).toHaveBeenCalledWith({
        fallbackRedirectUrl: "/",
        forceRedirectUrl: "/",
      });
    });

    let modelProviderRefreshes = 0;
    context.mocks.api(
      zeroPersonalModelProvidersMainContract.list,
      ({ respond }) => {
        modelProviderRefreshes += 1;
        return respond(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "Unauthorized",
          },
        });
      },
    );

    menu = await openAccountMenu();
    await waitFor(() => {
      expect(modelProviderRefreshes).toBeGreaterThan(0);
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    mockedClerk.redirectToSignIn.mockClear();
    modelProviderRefreshes = 0;
    mockNow(new Date("2026-01-01T00:00:30.001Z"));

    await openAccountMenu();
    await waitFor(() => {
      expect(modelProviderRefreshes).toBeGreaterThan(0);
      expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
    });
  });

  it("localizes account actions without changing account data or routes", async () => {
    mockAdminAccountSidebar();
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
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: true },
    });

    let menu = await openAccountMenu();
    expect(within(menu).getByText("Alex Rivera")).toBeVisible();
    expect(within(menu).getByText("alex.rivera@example.test")).toBeVisible();
    expect(within(menu).getByText("Configurações")).toBeVisible();
    expect(within(menu).getByText("Trocar de conta")).toBeVisible();
    expect(within(menu).getByText("Exportar dados")).toBeVisible();
    expect(within(menu).getByText("Sair")).toBeVisible();

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
    expect(screen.getByText("Jamie Chen")).toBeVisible();
    expect(screen.getByText("jamie.chen@example.test")).toBeVisible();
    expect(screen.getByText("Adicionar conta")).toBeVisible();
  });
});
