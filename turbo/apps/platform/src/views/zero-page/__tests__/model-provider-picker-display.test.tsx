/**
 * Regression tests for ModelProviderPicker null-value display.
 *
 * Bug (fix/model-picker-default-display): when value is null, the trigger
 * showed nothing instead of the org default model name.
 *
 * Tests page-level behavior via the Profile tab (settings-tab) as the entry
 * point, following platform testing principles:
 * - Entry point: detachedSetupPage + navigate to Profile tab
 * - Mock (external): Web API via MSW + setMockOrgModelProviders + setMockFeatureSwitches
 * - Real (internal): All signals, components, rendering
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FeatureSwitchKey,
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";

const context = testContext();

function setupMockAgent() {
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-detail-id",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: "professional",
      avatarUrl: "preset:0",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-user-123",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: "professional",
        avatarUrl: "preset:0",
        permissionPolicies: null,
        customSkills: [] as string[],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

async function openProfileTab(user: ReturnType<typeof userEvent.setup>) {
  detachedSetupPage({ context, path: "/agents/my-agent" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
  await user.click(screen.getByText(/Profile/i));
  await waitFor(() => {
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });
}

describe("model-provider-picker - display with null value", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
  });

  // MPKR-D-001: When value is null and default provider has a selectedModel,
  // the trigger must show that model's display name, not blank or placeholder.
  it("shows default provider selectedModel display name when value is null (MPKR-D-001)", async () => {
    const user = userEvent.setup();
    setupMockAgent();
    setMockFeatureSwitches({ [FeatureSwitchKey.ModelProviderSelection]: true });
    setMockOrgModelProviders([
      {
        id: "00000000-0000-4000-a000-000000000001",
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: true,
        selectedModel: "claude-opus-4-6",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    await openProfileTab(user);

    await waitFor(() => {
      // The trigger aria-label should reflect the default model, not the placeholder
      expect(
        screen.getByRole("combobox", { name: "Claude Opus 4.6" }),
      ).toBeInTheDocument();
    });
  });

  // MPKR-D-002: When value is null and default provider has selectedModel=null,
  // fall back to getDefaultModel for the provider type (claude-sonnet-4-6 for anthropic-api-key).
  it("falls back to provider type default model when selectedModel is null (MPKR-D-002)", async () => {
    const user = userEvent.setup();
    setupMockAgent();
    setMockFeatureSwitches({ [FeatureSwitchKey.ModelProviderSelection]: true });
    setMockOrgModelProviders([
      {
        id: "00000000-0000-4000-a000-000000000002",
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: true,
        selectedModel: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    await openProfileTab(user);

    await waitFor(() => {
      // anthropic-api-key defaultModel is "claude-sonnet-4-6" → "Claude Sonnet 4.6"
      expect(
        screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
      ).toBeInTheDocument();
    });
  });

  // MPKR-D-003: When value is null and no provider is marked as default,
  // the trigger must show the placeholder text.
  it("shows placeholder when no default provider exists (MPKR-D-003)", async () => {
    const user = userEvent.setup();
    setupMockAgent();
    setMockFeatureSwitches({ [FeatureSwitchKey.ModelProviderSelection]: true });
    setMockOrgModelProviders([
      {
        id: "00000000-0000-4000-a000-000000000003",
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: false,
        selectedModel: "claude-opus-4-6",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    await openProfileTab(user);

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Inherit from org default" }),
      ).toBeInTheDocument();
    });
  });
});
