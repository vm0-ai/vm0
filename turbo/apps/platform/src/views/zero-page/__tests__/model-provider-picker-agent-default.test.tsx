/**
 * Regression tests for the agent-vs-workspace default labeling and the
 * "Use default" reset option in ModelProviderPicker.
 *
 * Background (refactor/chat-optimization):
 *   Bug 1 — when an agent did not specify a default, the picker fell back to
 *   the workspace default but mislabeled it as "Agent default".
 *   Bug 2 — the INHERIT_SENTINEL item was removed, so a user who had
 *   overridden the model had no way to revert to the inherited default.
 *
 * These tests exercise the picker via the agent chat page entry point so
 * signals, MSW handlers, and rendering all run for real — only the Web API
 * is mocked, per project testing principles.
 *
 * Agent-has-a-model tests wait on `document.title` (set by the same reactive
 * chain that feeds the picker) to confirm the agent data has propagated
 * before asserting on the trigger label — the pattern used throughout
 * `chat-default-model-resolution.test.tsx`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
  // Single provider (Anthropic, workspace default = Sonnet). Keeps model
  // names unique in the dropdown so getByRole("option") is unambiguous.
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
 * updated by the same reactive chain (`currentChatAgent$` -> display name)
 * that feeds the picker's `agentDefault` prop, so once the title contains
 * the agent name, the picker has received the agent-level default.
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
    expect(
      screen.getByRole("option", { name: /Use .+ default/ }),
    ).toBeInTheDocument();
  });
}

describe("model-provider-picker - agent/workspace default source", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockOnboardingStatus();
    setMockFeatureSwitches({});
    // Pin currentChatAgentId$ resolution to the test agent so route setup
    // on `/agents/:id/chat` doesn't race with the default-agent lookup.
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
    setupProviders();
  });

  // MPKR-AD-002: Chat picker uses inheritLabel="agent", so the badge and
  // toggle always say "Agent default" even when the agent has no model set
  // and the resolved default comes from the workspace.
  it("shows model options without default badge in chat context (MPKR-AD-002)", async () => {
    const user = userEvent.setup();
    mockAgentWith({ modelProviderId: null, selectedModel: null });

    await openPickerOnAgentChat(user, "Claude Sonnet 4.6");

    // Model items no longer carry a default badge — the toggle row
    // already communicates which model is the inherited default.
    expect(screen.queryByText("Agent default")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace default")).not.toBeInTheDocument();
  });

  // MPKR-AD-004: The inherit toggle in chat shows "Use agent default" with
  // the effective model name.
  it("toggle shows 'Use agent default' with model name (MPKR-AD-004)", async () => {
    const user = userEvent.setup();
    mockAgentWith({ modelProviderId: null, selectedModel: null });

    await openPickerOnAgentChat(user, "Claude Sonnet 4.6");

    const toggle = screen.getByLabelText("Use agent default model");
    expect(toggle).toBeInTheDocument();
    expect(screen.getAllByText("Claude Sonnet 4.6").length).toBeGreaterThan(0);
  });

  // MPKR-AD-005: When the agent specifies its own default (Opus 4.7), the
  // picker trigger shows the agent model — not the workspace default. This
  // pins the primary regression scenario for Bug 1 (agent default mislabel).
  it("trigger shows the agent model when the agent specifies one (MPKR-AD-005)", async () => {
    mockAgentWith({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Claude Opus 4.7" }),
      ).toBeInTheDocument();
    });
  });

  // MPKR-AD-006: Opening the dropdown when the agent has its own model still
  // surfaces the "Use agent default" toggle, reflecting the agent's model
  // (Opus 4.7) — not the workspace default (Sonnet 4.6).
  it("toggle reflects the agent model as the inherited default (MPKR-AD-006)", async () => {
    const user = userEvent.setup();
    mockAgentWith({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    const trigger = await waitFor(() => {
      return screen.getByRole("combobox", { name: "Claude Opus 4.7" });
    });
    await user.click(trigger);

    const toggle = await waitFor(() => {
      return screen.getByLabelText("Use agent default model");
    });
    expect(toggle).toBeInTheDocument();
    // The toggle row must show the agent's model as the inherited value,
    // and the Sonnet-based workspace default must not leak through as the
    // inherited label.
    expect(screen.getAllByText("Claude Opus 4.7").length).toBeGreaterThan(0);
  });
});
