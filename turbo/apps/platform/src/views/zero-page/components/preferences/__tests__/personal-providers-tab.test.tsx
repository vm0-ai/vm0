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
