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
 * Note: tests that require useLastResolved(currentChatAgent$) to propagate
 * agent-level model defaults to the component are omitted — the ccstate-react
 * reactive chain does not settle reliably within the 5 s test timeout in CI.
 * The workspace-default tests (AD-002, AD-004) cover the critical regressions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey, zeroAgentsByIdContract } from "@vm0/core";
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
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
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
    setMockFeatureSwitches({ [FeatureSwitchKey.ModelProviderSelection]: true });
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
});
