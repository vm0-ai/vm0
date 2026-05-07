/**
 * Integration tests for the Personal model providers tab in Preferences.
 * Covers feature switch gating, vm0 exclusion, CodexBeta carryover,
 * and CRUD round-trips against the MSW personal-tier handlers.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { testContext } from "../../../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
} from "../../../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../../../mocks/handlers/api-feature-switches.helpers.ts";
import { setMockPersonalModelProviders } from "../../../../../mocks/handlers/api-personal-model-providers.ts";
import { setMockUserPreferences } from "../../../../../mocks/handlers/api-user-preferences.ts";

const context = testContext();

function mockPreferences(): void {
  setMockUserPreferences({
    timezone: null,
    pinnedAgentIds: [],
    sendMode: "enter",
    captureNetworkBodiesRemaining: 0,
  });
}

function makeProvider(
  type: ModelProviderType,
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type,
    framework: "claude-code",
    secretName:
      type === "claude-code-oauth-token"
        ? "CLAUDE_CODE_OAUTH_TOKEN"
        : "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    createdAt: now,
    updatedAt: now,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    ...overrides,
  };
}

describe("personal-providers-tab — feature switch gating", () => {
  it("hides the Model Providers tab when personalModelProvider is off", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: false,
    });
    mockPreferences();
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    expect(screen.queryByText("Model Providers")).not.toBeInTheDocument();
  });

  it("shows the Model Providers tab when personalModelProvider is on", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    mockPreferences();
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
  });
});

describe("personal-providers-tab — empty state and vm0 filter", () => {
  it("shows 'No providers configured' empty state when list is empty", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    await waitFor(() => {
      expect(screen.getByText("Personal model providers")).toBeInTheDocument();
    });
    expect(screen.getByText("No providers configured")).toBeInTheDocument();
  });

  it("does not list vm0 in the add provider dialog (Epic Decision 4)", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    await waitFor(() => {
      expect(
        screen.getByTestId("personal-add-provider-button"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("personal-add-provider-button"));

    await waitFor(() => {
      expect(
        screen.getByText("Add personal model provider"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("personal-provider-card-vm0"),
    ).not.toBeInTheDocument();
  });

  it("excludes openai-api-key when codex-beta is off (CodexBeta carryover)", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
      [FeatureSwitchKey.CodexBeta]: false,
    });
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    await waitFor(() => {
      expect(
        screen.getByTestId("personal-add-provider-button"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("personal-add-provider-button"));

    await waitFor(() => {
      expect(
        screen.getByText("Add personal model provider"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("personal-provider-card-openai-api-key"),
    ).not.toBeInTheDocument();
    // Anthropic should still be selectable.
    expect(
      screen.getByTestId("personal-provider-card-anthropic-api-key"),
    ).toBeInTheDocument();
  });
});

describe("personal-providers-tab — provider list rendering", () => {
  it("renders seeded personal providers as tiles", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    mockPreferences();
    setMockPersonalModelProviders([
      makeProvider("anthropic-api-key", { isDefault: true }),
      makeProvider("openai-api-key"),
    ]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    // Wait for the tab content to mount before asserting tile presence.
    await waitFor(() => {
      expect(screen.getByText("Personal model providers")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("personal-provider-tile-anthropic-api-key"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("personal-provider-tile-openai-api-key"),
    ).toBeInTheDocument();
  });

  it("shows the seeded default provider in the personal default selector", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    mockPreferences();
    setMockPersonalModelProviders([
      makeProvider("anthropic-api-key", { isDefault: true }),
    ]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    await waitFor(() => {
      expect(screen.getByText("Personal default")).toBeInTheDocument();
    });
    // The default selector trigger renders the label of the current default.
    expect(screen.getByRole("combobox")).toHaveTextContent(/Anthropic/i);
  });
});

// ===========================================================================
// codex-oauth-token paste flow on personal scope (#12024)
//
// Mirrors the org-side coverage in zero-page/__tests__/
// org-add-provider-dialog-codex.test.tsx. Verifies:
// - The Codex card is gated on FeatureSwitchKey.CodexOauthProvider
// - Clicking the Codex card opens the paste dialog (not the generic form)
// - The stale-provider banner appears when needsReconnect=true
// - Banner button opens the paste dialog in reconnect mode
// ===========================================================================

describe("personal-providers-tab — codex paste flow", () => {
  function makeStaleCodexProvider(): ModelProviderResponse {
    const now = new Date().toISOString();
    return {
      id: "00000000-0000-4000-a000-000000000020",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: "CHATGPT_ACCESS_TOKEN",
      authMethod: "auth_json",
      secretNames: [
        "CHATGPT_ACCESS_TOKEN",
        "CHATGPT_REFRESH_TOKEN",
        "CHATGPT_ACCOUNT_ID",
        "CHATGPT_ID_TOKEN",
      ],
      isDefault: false,
      selectedModel: null,
      createdAt: now,
      updatedAt: now,
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
      workspaceName: "Personal Acme",
      planType: "plus",
    };
  }

  it("hides the Codex card when the codexOauthProvider feature switch is off", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
      // CodexOauthProvider deliberately omitted → defaults to off
    });
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    await waitFor(() => {
      expect(
        screen.getByTestId("personal-add-provider-button"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("personal-add-provider-button"));

    await waitFor(() => {
      expect(
        screen.getByText("Add personal model provider"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("personal-provider-card-codex-oauth-token"),
    ).not.toBeInTheDocument();
  });

  it("clicking the Codex card opens the paste dialog (not the generic form)", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
      [FeatureSwitchKey.CodexOauthProvider]: true,
    });
    mockPreferences();
    setMockPersonalModelProviders([]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    await waitFor(() => {
      expect(
        screen.getByTestId("personal-add-provider-button"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("personal-add-provider-button"));

    const codexCard = await screen.findByTestId(
      "personal-provider-card-codex-oauth-token",
    );
    click(codexCard);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: /Connect Codex/i }),
      ).toBeInTheDocument();
    });

    // The textarea is present (paste-modal UX), not a 5-field generic form
    expect(screen.getByTestId("codex-paste-textarea")).toBeInTheDocument();
  });

  it("renders the stale-provider banner when a personal codex provider needs reconnection", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
      [FeatureSwitchKey.CodexOauthProvider]: true,
    });
    mockPreferences();
    setMockPersonalModelProviders([makeStaleCodexProvider()]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    await waitFor(() => {
      expect(
        screen.getByText("ChatGPT session needs reconnection"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Your ChatGPT session expired. Re-connect to continue."),
    ).toBeInTheDocument();
  });

  it("re-paste auth.json banner button opens the paste dialog in reconnect mode", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
      [FeatureSwitchKey.CodexOauthProvider]: true,
    });
    mockPreferences();
    setMockPersonalModelProviders([makeStaleCodexProvider()]);
    detachedSetupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Model Providers")).toBeInTheDocument();
    });
    click(screen.getByText("Model Providers"));

    const reconnectBtn = await screen.findByText("Re-paste auth.json");
    click(reconnectBtn);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: /Re-connect Codex/i }),
      ).toBeInTheDocument();
    });
  });
});
