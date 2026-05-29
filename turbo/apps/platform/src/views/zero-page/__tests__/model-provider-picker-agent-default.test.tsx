/**
 * Regression tests for model-first picker defaults.
 *
 * Background (refactor/chat-optimization):
 *   The inherited user/workspace default should resolve the trigger display,
 *   but it should not appear as a separate "Use default" option in the menu.
 *
 * These tests exercise the picker via the agent chat page entry point so
 * signals, MSW handlers, and rendering all run for real — only the Web API
 * is mocked, per project testing principles.
 *
 * Agent model fields are intentionally ignored: model-first uses the user's
 * model preference first, then the workspace default.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  setMockOnboardingStatus,
  resetMockOnboardingStatus,
} from "../../../mocks/handlers/api-onboarding.ts";
import {
  resetMockUserModelPreference,
  setMockUserModelPreference,
} from "../../../mocks/handlers/api-user-model-preference.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "e0000000-0000-4000-a000-000000000010";
const ANTHROPIC_PROVIDER_ID = "00000000-0000-4000-a000-000000000001";

function mockAgentWith(params: {
  modelProviderId: string | null;
  selectedModel: string | null;
}) {
  setMockTeam([
    {
      id: AGENT_ID,
      displayName: "Scout",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: AGENT_ID,
        ownerId: "test-user-123",
        displayName: "Scout",
        description: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [] as string[],
        modelProviderId: params.modelProviderId,
        selectedModel: params.selectedModel,
      });
    }),
  );
}

function setupProviders() {
  // Single Anthropic provider so the org has a provider configured. The
  // picker's workspace default is resolved from the default model-policy
  // seed (DeepSeek V4 Pro), not from this provider row.
  setMockOrgModelProviders([
    {
      id: ANTHROPIC_PROVIDER_ID,
      type: "anthropic-api-key",
      framework: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      authMethod: null,
      secretNames: null,
      isDefault: true,
      selectedModel: "claude-sonnet-4-6",
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

/**
 * Wait for the agent chat page to finish initialising. `document.title` is
 * updated by the same reactive chain (`currentChatAgent$` -> display name),
 * so once the title contains the agent name, the chat page has initialised.
 */
async function expectAgentChatLoaded(): Promise<void> {
  await waitFor(() => {
    expect(document.title).toContain("Scout");
  });
}

async function openPickerOnAgentChat(
  user: ReturnType<typeof userEvent.setup>,
  initialLabel: string,
) {
  detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const trigger = await waitFor(() => {
    return screen.getByRole("combobox", { name: initialLabel });
  });
  await user.click(trigger);
  await waitFor(() => {
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
}

describe("model-provider-picker - user/workspace default source", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockOnboardingStatus();
    resetMockUserModelPreference();
    setMockFeatureSwitches({});
    // Pin currentChatAgentId$ resolution to the test agent so route setup
    // on `/agents/:id/chat` doesn't race with the default-agent lookup.
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
    setupProviders();
  });

  it("does not show default badges in chat context (MPKR-AD-002)", async () => {
    const user = userEvent.setup();
    mockAgentWith({ modelProviderId: null, selectedModel: null });

    await openPickerOnAgentChat(user, "DeepSeek V4 Pro");

    expect(screen.queryByLabelText(/Use .+ default model/)).toBeNull();
    expect(screen.queryByText("Agent default")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace default")).not.toBeInTheDocument();
  });

  // MPKR-AD-004: Default inheritance is implicit; the menu opens directly on
  // model options instead of a "Use workspace default" toggle.
  it("does not show a workspace default toggle (MPKR-AD-004)", async () => {
    const user = userEvent.setup();
    mockAgentWith({ modelProviderId: null, selectedModel: null });

    await openPickerOnAgentChat(user, "DeepSeek V4 Pro");

    expect(screen.queryByLabelText("Use workspace default model")).toBeNull();
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).queryByText("Default")).toBeNull();
    expect(within(listbox).getByText("Models")).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: /DeepSeek V4 Pro/ }),
    ).toHaveAttribute("aria-selected", "true");
  });

  // MPKR-AD-005: Agent model fields no longer affect the picker.
  it("ignores an agent model and shows the workspace default (MPKR-AD-005)", async () => {
    mockAgentWith({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "DeepSeek V4 Pro" }),
      ).toBeInTheDocument();
    });
  });

  // MPKR-AD-006: A user preference becomes the inherited trigger value without
  // surfacing a separate personal-default option.
  it("uses the user preference without showing a personal default option (MPKR-AD-006)", async () => {
    const user = userEvent.setup();
    setMockUserModelPreference({
      selectedModel: "claude-opus-4-8",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgentWith({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    const trigger = await waitFor(() => {
      return screen.getByRole("combobox", { name: "Claude Opus 4.8" });
    });
    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Use personal default model")).toBeNull();
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).queryByText("Default")).toBeNull();
    expect(within(listbox).getByText("Models")).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: /Claude Opus 4\.8/ }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
