import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { clearMockNow, mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";

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

async function openAccountMenu(): Promise<HTMLElement> {
  const accountName = await screen.findByText("Alex Rivera");
  const accountButton = accountName.closest("button");
  if (!accountButton) {
    throw new Error("Account menu trigger not found");
  }
  click(accountButton);
  return screen.findByRole("menu");
}

function mockAdminAccountSidebar(): void {
  prepareDefaultAgent();
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(200, splitChatThreadListResponse([]));
  });
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
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
    expect(
      within(panel).queryByText(/codex\.user@example\.com/),
    ).not.toBeInTheDocument();

    const codexFiveHour = within(panel).getByRole("progressbar", {
      name: "Codex 5h remaining",
    });
    expect(codexFiveHour).toHaveAttribute("aria-valuenow", "82");

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
    click(within(confirmDialog).getByRole("button", { name: "Reset usage" }));

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

  it("opens memory from the account menu", async () => {
    mockAdminAccountSidebar();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    const menu = await openAccountMenu();
    click(within(menu).getByText("Memory"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Memory" }),
      ).toBeInTheDocument();
      expect(screen.getByText("No updates yet")).toBeInTheDocument();
    });
  });

  it("opens settings from the account menu and changes debug capture", async () => {
    prepareDefaultAgent();
    context.mocks.data.userPreferences({
      captureNetworkBodiesRemaining: 0,
    });
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
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

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(mockedClerk.openUserProfile).toHaveBeenCalledWith({
        apiKeysProps: { hide: true },
      });
    });

    const clerkProfileModal = document.createElement("div");
    clerkProfileModal.dataset.clerkUserProfile = "";
    document.body.append(clerkProfileModal);
    await waitFor(() => {
      expect(clerkProfileModal).toBeInTheDocument();
    });
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
  });

  it("shows account switching, add-account, and sign-out actions", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

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
});
