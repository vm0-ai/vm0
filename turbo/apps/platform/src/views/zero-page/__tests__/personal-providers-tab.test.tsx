import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import {
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { clearMockNow, mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

afterEach(async () => {
  clearMockNow();
  document.documentElement.lang = DEFAULT_LOCALE;
  await initializeI18n(DEFAULT_LOCALE);
});

function stalePersonalCodexProvider(): ModelProviderResponse {
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
    subscriptionResetPeriod: "Weekly",
    subscriptionNextResetAt: "2030-01-01T00:00:00.000Z",
    accountEmail: "codex.user@example.com",
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function connectedPersonalCodexProvider(): ModelProviderResponse {
  return {
    ...stalePersonalCodexProvider(),
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
  };
}

function connectedPersonalClaudeCodeProvider(): ModelProviderResponse {
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
  };
}

function mockPersonalProvidersStory(role: "admin" | "member" = "member"): void {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role,
  });
  context.mocks.data.personalModelProviders([stalePersonalCodexProvider()]);
  context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-personal-codex-device-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "PERS-1234",
      expiresIn: 30,
      interval: 1,
    });
  });
  context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
}

function mockBillingCapabilities(modelCapabilities: {
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
}): void {
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    const status: BillingStatusResponse = {
      tier: "pro",
      ...modelCapabilities,
      credits: 20_000,
      onboardingPaymentPending: false,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: false,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    };
    return respond(200, status);
  });
}

async function openModelSettings(heading = "Models"): Promise<void> {
  detachedSetupPage({
    context,
    path: "/?settings=model",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });
}

function dialogContaining(element: HTMLElement): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Containing dialog not found");
  }
  return dialog;
}

async function findLatestClaudeCodeInput(): Promise<HTMLInputElement> {
  const inputs = await screen.findAllByTestId("claude-code-device-auth-code");
  const input = inputs.at(-1);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Claude Code authorization code input not found");
  }
  return input;
}

function closeDialogsContainingTestId(testId: string): void {
  const dialogs = new Set(
    screen.queryAllByTestId(testId).map((input) => {
      return dialogContaining(input);
    }),
  );
  for (const dialog of dialogs) {
    if (document.body.contains(dialog)) {
      click(within(dialog).getByLabelText("Close"));
    }
  }
}

function closeClaudeCodeDialogs(): void {
  closeDialogsContainingTestId("claude-code-device-auth-code");
}

function connectButtonInRow(row: HTMLElement, label: string): HTMLElement {
  const button = queryAllByRoleFast("button", row).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
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

function formatResetInTimeZone(resetAt: string, timeZone: string): string {
  return `resets ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(resetAt))}`;
}

function mockBrowserTimeZone(timeZone: string): void {
  const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolvedOptions,
    timeZone,
  });
}

describe("personal model providers settings", () => {
  it("offers Pro upgrade when personal BYOK is unsupported", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.personalModelProviders([]);
    mockBillingCapabilities({ supportByok: false, restrictedVm0Models: false });

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    const claudeUpgrade = connectButtonInRow(
      claudeCodeRow,
      "Upgrade Pro to use Claude Code OAuth",
    );
    expect(claudeUpgrade).toHaveTextContent("Upgrade Pro to use");
    expect(
      connectButtonInRow(codexRow, "Upgrade Pro to use ChatGPT (Codex)"),
    ).toHaveTextContent("Upgrade Pro to use");

    click(claudeUpgrade);

    await expect(
      screen.findByRole("heading", { name: "Compare plans" }),
    ).resolves.toBeInTheDocument();
  });

  it("opens personal Claude Code login from model settings", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([]);
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-personal-claude-code-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    expect(
      within(claudeCodeRow).getByText("Claude Code OAuth"),
    ).toBeInTheDocument();
    const connectButton = connectButtonInRow(
      claudeCodeRow,
      "Connect Claude Code OAuth",
    );
    click(connectButton);

    const authorizationCodeInputs = await screen.findAllByTestId(
      "claude-code-device-auth-code",
    );
    expect(authorizationCodeInputs).not.toHaveLength(0);
    expect(screen.getAllByText("Connect Claude Code")).not.toHaveLength(0);
    closeClaudeCodeDialogs();
    await waitFor(() => {
      expect(
        screen.queryAllByTestId("claude-code-device-auth-code"),
      ).toHaveLength(0);
    });
  });

  it("connects personal Claude Code with an authorization code", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([]);
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-personal-claude-code-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });
    context.mocks.api(
      zeroClaudeCodeDeviceAuthContract.complete,
      ({ respond }) => {
        const provider = connectedPersonalClaudeCodeProvider();
        context.mocks.data.personalModelProviders([provider]);
        return respond(200, {
          status: "complete",
          provider,
          created: true,
        });
      },
    );

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    const connectButton = connectButtonInRow(
      claudeCodeRow,
      "Connect Claude Code OAuth",
    );
    click(connectButton);

    const codeInput = await findLatestClaudeCodeInput();
    const deviceAuthDialog = dialogContaining(codeInput);
    await fill(codeInput, "claude-auth-code");
    click(
      within(deviceAuthDialog).getByTestId("claude-code-device-auth-submit"),
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Code connected")).toBeInTheDocument();
      expect(
        within(claudeCodeRow).getByText("Connected (Pro)"),
      ).toBeInTheDocument();
      expect(
        within(claudeCodeRow).queryByText(/claude\.user@example\.com/),
      ).not.toBeInTheDocument();
      expect(within(claudeCodeRow).getByText("88% left")).toBeInTheDocument();
      expect(within(claudeCodeRow).getByText("76% left")).toBeInTheDocument();
      expect(
        within(claudeCodeRow).queryByText(/Unavailable|Unknown/),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps Claude Code validation inline and suppresses transport error toasts", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([]);
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-personal-claude-code-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });
    let completeCount = 0;
    context.mocks.api(
      zeroClaudeCodeDeviceAuthContract.complete,
      ({ respond }) => {
        completeCount += 1;
        if (completeCount === 1) {
          return respond(400, {
            error: {
              message: "Invalid Claude authorization code",
              code: "BAD_REQUEST",
            },
          });
        }
        return respond(503, {
          error: {
            message: "Claude authorization is unavailable",
            code: "UNAVAILABLE",
          },
        });
      },
    );

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    click(connectButtonInRow(claudeCodeRow, "Connect Claude Code OAuth"));
    const codeInput = await findLatestClaudeCodeInput();
    const dialog = dialogContaining(codeInput);
    await fill(codeInput, "invalid-claude-code");
    const submit = within(dialog).getByTestId("claude-code-device-auth-submit");
    click(submit);

    await expect(
      within(dialog).findByText("Invalid Claude authorization code"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });

    click(submit);
    await expect(
      screen.findByText("Claude authorization is unavailable"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });

    context.mocks.http.post(
      "*/api/zero/model-providers/claude-code/device-auth/sessions/complete",
      () => {
        return HttpResponse.error();
      },
    );
    click(submit);
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("shows available subscription details in the connected status", async () => {
    mockBrowserTimeZone("America/New_York");
    mockNow(new Date("2030-01-01T00:48:00.000Z"));
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([
      connectedPersonalClaudeCodeProvider(),
      connectedPersonalCodexProvider(),
    ]);

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    expect(
      within(claudeCodeRow).getByText("Connected (Pro)"),
    ).toBeInTheDocument();
    expect(
      within(claudeCodeRow).queryByText(/claude\.user@example\.com/),
    ).not.toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("5h")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("88% left")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("in 4h 12m")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("Week")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("76% left")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("in 5d 23h")).toBeInTheDocument();
    expect(
      within(claudeCodeRow).getByText(
        formatResetInTimeZone("2030-01-01T05:00:00.000Z", "America/New_York"),
      ),
    ).toBeInTheDocument();
    expect(
      within(claudeCodeRow).queryByText(/Unavailable|Unknown|Account:|Reset:/),
    ).not.toBeInTheDocument();

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    expect(within(codexRow).getByText("Connected (Pro)")).toBeInTheDocument();
    expect(
      within(codexRow).queryByText(/Personal ChatGPT/),
    ).not.toBeInTheDocument();
    expect(
      within(codexRow).queryByText(/codex\.user@example\.com/),
    ).not.toBeInTheDocument();
    expect(within(codexRow).getByText("82% left")).toBeInTheDocument();
    expect(within(codexRow).getByText("in 4h 12m")).toBeInTheDocument();
    expect(within(codexRow).getByText("55% left")).toBeInTheDocument();
    expect(within(codexRow).getByText("in 5d 23h")).toBeInTheDocument();
    expect(
      within(codexRow).queryByText(/Account:|Plan:|Reset:|Connected .*resets/),
    ).not.toBeInTheDocument();
  });

  it("localizes subscription reset dates and relative times in Japanese", async () => {
    const timeZone = "Asia/Tokyo";
    mockBrowserTimeZone(timeZone);
    mockNow(new Date("2030-01-01T00:48:00.000Z"));
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([
      connectedPersonalClaudeCodeProvider(),
    ]);
    context.mocks.data.userPreferences({
      locale: "ja-JP",
      supportedLocales: ["en-US", "ja-JP"],
    });

    await openModelSettings("モデル");

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    expect(document.documentElement.lang).toBe("ja-JP");
    expect(within(claudeCodeRow).getByText("5時間")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("88% 残り")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("4時間12分後")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("週")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("76% 残り")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("5日23時間後")).toBeInTheDocument();

    const resetAt = "2030-01-01T05:00:00.000Z";
    const absoluteReset = new Intl.DateTimeFormat("ja-JP", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(resetAt));
    expect(
      within(claudeCodeRow).getByText(`${absoluteReset}にリセット`),
    ).toBeInTheDocument();
  });

  it("localizes subscription reset dates and relative times in Spanish", async () => {
    const timeZone = "Europe/Madrid";
    mockBrowserTimeZone(timeZone);
    mockNow(new Date("2030-01-01T00:48:00.000Z"));
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([
      connectedPersonalClaudeCodeProvider(),
    ]);
    context.mocks.data.userPreferences({
      locale: "es-ES",
      supportedLocales: ["en-US", "es-ES"],
    });

    await openModelSettings("Modelos");

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    expect(document.documentElement.lang).toBe("es-ES");
    expect(within(claudeCodeRow).getByText("5h")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("88% restante")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("en 4h 12m")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("Semana")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("76% restante")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("en 5d 23h")).toBeInTheDocument();

    const resetAt = "2030-01-01T05:00:00.000Z";
    const absoluteReset = new Intl.DateTimeFormat("es-ES", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(resetAt));
    expect(
      within(claudeCodeRow).getByText(`se restablece el ${absoluteReset}`),
    ).toBeInTheDocument();
  });

  it("resets connected personal Codex usage from the row menu", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);

    await openModelSettings();

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    expect(
      within(codexRow).queryByText(/codex\.user@example\.com/),
    ).not.toBeInTheDocument();

    click(within(codexRow).getByLabelText("More options"));
    await expect(
      screen.findByText("2 resets left"),
    ).resolves.toBeInTheDocument();
    click(screen.getByText("Reset usage"));

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

    click(within(codexRow).getByLabelText("More options"));
    await expect(
      screen.findByText("1 reset left"),
    ).resolves.toBeInTheDocument();
  });

  it("falls back to stored Claude Code reset metadata when usage is unavailable", async () => {
    mockBrowserTimeZone("America/New_York");
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([
      {
        ...connectedPersonalClaudeCodeProvider(),
        subscriptionUsage: undefined,
      },
    ]);

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    expect(
      within(claudeCodeRow).getByText("Connected (Pro)"),
    ).toBeInTheDocument();
    expect(
      within(claudeCodeRow).getByText(
        formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
      ),
    ).toBeInTheDocument();
    expect(
      within(claudeCodeRow).queryByText("76% left"),
    ).not.toBeInTheDocument();
  });

  it("opens reconnect login from a stale personal Codex credential", async () => {
    mockPersonalProvidersStory();
    await openModelSettings();

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(within(codexRow).getByText("Attention")).toBeInTheDocument();

    click(within(codexRow).getByLabelText("More options"));
    click(await screen.findByText("Replace"));

    await waitFor(() => {
      expect(screen.getAllByText("Re-connect Codex")).not.toHaveLength(0);
      const deviceAuthCodes = screen.getAllByTestId("codex-device-auth-code");
      expect(deviceAuthCodes).not.toHaveLength(0);
      for (const deviceAuthCode of deviceAuthCodes) {
        expect(deviceAuthCode).toHaveTextContent("PERS-1234");
      }
    });
  });

  it("disconnects a connected personal Codex credential", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);
    await openModelSettings();

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(within(codexRow).getByText(/^Connected/)).toBeInTheDocument();

    click(within(codexRow).getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(
        within(codexRow).queryByText(/^Connected/),
      ).not.toBeInTheDocument();
      expect(
        queryAllByRoleFast("button", codexRow).find((button) => {
          return button.textContent?.trim() === "Connect";
        }),
      ).toBeInTheDocument();
    });
  });

  it("localizes personal model device authentication without changing provider data", async () => {
    mockPersonalProvidersStory("admin");
    context.mocks.data.orgModelProviders([]);
    context.mocks.data.orgModelPolicies([]);
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    await openModelSettings("Modelos");

    click(screen.getByText("Adicionar modelo"));
    const policyDialog = screen.getByRole("dialog", {
      name: "Adicionar modelo",
    });
    click(within(policyDialog).getByRole("combobox"));
    click(await screen.findByRole("option", { name: "Claude Opus 4.7" }));
    click(screen.getByRole("radio", { name: /Chave de API/u }));
    expect(
      within(policyDialog).getByText("Chave de API da Anthropic"),
    ).toBeVisible();
    expect(
      within(policyDialog).getByPlaceholderText("Insira sua chave de API"),
    ).toBeVisible();
    click(buttonByText("Adicionar modelo", policyDialog));
    expect(
      within(policyDialog).getByText("A chave de API é obrigatória"),
    ).toBeVisible();
    click(buttonByLabel("Fechar", policyDialog));

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeVisible();
    expect(within(codexRow).getByText("Atenção")).toBeVisible();

    click(within(codexRow).getByLabelText("Mais opções"));
    click(await screen.findByText("Substituir"));

    const personalCode = (
      await screen.findAllByTestId("codex-device-auth-code")
    ).find((candidate) => {
      return candidate.textContent === "PERS-1234";
    });
    if (!(personalCode instanceof HTMLElement)) {
      throw new Error("Personal Codex device code not found");
    }
    const personalDialog = dialogContaining(personalCode);
    expect(
      within(personalDialog).getByText("Reconectar o Codex"),
    ).toBeInTheDocument();
    expect(
      within(personalDialog).getByText(
        /mantenha esta caixa de diálogo aberta enquanto o VM0 conclui a conexão/u,
      ),
    ).toBeVisible();
  });
});
