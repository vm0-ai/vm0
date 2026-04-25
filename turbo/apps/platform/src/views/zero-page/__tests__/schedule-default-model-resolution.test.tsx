/**
 * Default model resolution tests for the schedule composer dialog.
 *
 * Covers the priority chain for what model name appears in the schedule
 * create dialog's Model picker when the dialog opens for an agent:
 *
 *   agent default  >  org default
 *
 * This mirrors the chat-composer priority chain from PR #10431. The
 * schedule dialog previously showed only the org default when the form's
 * `modelProviderId/selectedModel` were null, producing a display/run
 * mismatch when the agent had its own custom model (the backend resolves
 * against the agent default, but the picker advertised the org default).
 *
 * Entry point: /schedules page, clicking "Add schedule".
 *
 * Mock (external): Web API via MSW contract helpers (feature switches,
 *   team list, agent detail, org model providers, onboarding status).
 * Real (internal): routing, bootstrap, `openCreateScheduleDialog$` flow,
 *   all ccstate signals, schedule dialog rendering.
 *
 * Each test mounts a fresh page — re-entering a route within the same
 * store can reuse cached ccstate computed values (e.g. orgModelProviders$,
 * agentById) and obscure the assertion. Each test seeds its mocks, mounts
 * the page, and clicks to open the dialog.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockSchedules } from "../../../mocks/handlers/api-schedules.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import {
  setMockFeatureSwitches,
  resetMockFeatureSwitches,
} from "../../../mocks/handlers/api-feature-switches.ts";
import {
  setMockOnboardingStatus,
  resetMockOnboardingStatus,
} from "../../../mocks/handlers/api-onboarding.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "e0000000-0000-4000-a000-000000000020";

const ANTHROPIC_PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
const MOONSHOT_PROVIDER_ID = "00000000-0000-4000-a000-000000000002";
const ZAI_PROVIDER_ID = "00000000-0000-4000-a000-000000000003";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface AgentModelConfig {
  modelProviderId: string | null;
  selectedModel: string | null;
}

function mockAgent(config: AgentModelConfig) {
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
        modelProviderId: config.modelProviderId,
        selectedModel: config.selectedModel,
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

function buildProvider(
  overrides: Partial<ModelProviderResponse> & {
    id: string;
    type: ModelProviderResponse["type"];
  },
): ModelProviderResponse {
  return {
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Seed three providers and mark one as the org default with the specified
 * selectedModel. Matches the chat-composer test helper so agent/thread
 * model picks don't collide with the org default.
 */
function mockOrgProviders(options: {
  defaultProviderId:
    | typeof ANTHROPIC_PROVIDER_ID
    | typeof MOONSHOT_PROVIDER_ID
    | typeof ZAI_PROVIDER_ID;
  defaultSelectedModel: string;
}) {
  setMockOrgModelProviders([
    buildProvider({
      id: MOONSHOT_PROVIDER_ID,
      type: "moonshot-api-key",
      secretName: "MOONSHOT_API_KEY",
      isDefault: options.defaultProviderId === MOONSHOT_PROVIDER_ID,
      selectedModel:
        options.defaultProviderId === MOONSHOT_PROVIDER_ID
          ? options.defaultSelectedModel
          : "kimi-k2.5",
    }),
    buildProvider({
      id: ANTHROPIC_PROVIDER_ID,
      type: "anthropic-api-key",
      secretName: "ANTHROPIC_API_KEY",
      isDefault: options.defaultProviderId === ANTHROPIC_PROVIDER_ID,
      selectedModel:
        options.defaultProviderId === ANTHROPIC_PROVIDER_ID
          ? options.defaultSelectedModel
          : "claude-sonnet-4-6",
    }),
    buildProvider({
      id: ZAI_PROVIDER_ID,
      type: "zai-api-key",
      secretName: "ZAI_API_KEY",
      isDefault: options.defaultProviderId === ZAI_PROVIDER_ID,
      selectedModel:
        options.defaultProviderId === ZAI_PROVIDER_ID
          ? options.defaultSelectedModel
          : "glm-5.1",
    }),
  ]);
}

async function openCreateDialog() {
  // Empty schedules list so only one "Add schedule" button is rendered
  // (header — the empty-state button is also labelled "Add schedule").
  setMockSchedules([]);
  detachedSetupPage({ context, path: "/schedules" });
  await waitFor(() => {
    expect(screen.getAllByText(/Add schedule/i)[0]).not.toBeDisabled();
  });
  click(screen.getAllByText(/Add schedule/i)[0]!);
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });
}

async function expectDialogPickerShowsModel(
  displayName: string,
): Promise<void> {
  await waitFor(() => {
    // The schedule dialog picker is a Radix Select with
    // aria-label = model display name. It is the "Model" picker inside
    // the Add-schedule dialog (distinct from the Agent/Time/Timezone
    // combobox triggers).
    expect(
      screen.getByRole("combobox", { name: displayName }),
    ).toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("schedule composer — default model resolution", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockFeatureSwitches();
    resetMockOnboardingStatus();
    setMockFeatureSwitches({});
    // Align onboarding default with the test agent so the create dialog
    // picks AGENT_ID as the seeded agent for the form.
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
  });

  // ---------------------------------------------------------------------------
  // Scenario 1 — org default flows through when the agent has no custom model
  // ---------------------------------------------------------------------------

  // SCHED-DM-001: Org default (Kimi K2.5) is shown in the schedule dialog's
  // Model picker when the agent has no model configured.
  it("shows the org default when the agent has no custom model (SCHED-DM-001)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    await openCreateDialog();

    await expectDialogPickerShowsModel("Kimi K2.5");
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — agent default overrides org default
  // ---------------------------------------------------------------------------

  // SCHED-DM-002: When the agent is pinned to Opus 4.7, the schedule dialog
  // shows Opus 4.7 even though the org default is Kimi K2.5. This is the
  // regression fixed in this PR — the chain was missed in PR #10431.
  it("shows the agent default when set (Opus 4.7 over org Kimi) (SCHED-DM-002)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });

    await openCreateDialog();

    await expectDialogPickerShowsModel("Claude Opus 4.7");
  });

  // SCHED-DM-003: Updating the agent's model (e.g. Opus 4.7 -> 4.6 via the
  // profile tab) flows through: opening a fresh create dialog against an
  // agent whose stored model is Opus 4.6 shows Opus 4.6. Pins the
  // "re-open dialog after editing profile" leg of the workflow.
  it("shows the updated agent default (Opus 4.6) after a profile edit (SCHED-DM-003)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-6",
    });

    await openCreateDialog();

    await expectDialogPickerShowsModel("Claude Opus 4.6");
  });

  // SCHED-DM-004: When the agent is reset to "use org default" (both fields
  // null), the dialog falls back to the org default.
  it("falls back to the org default when the agent clears its model (SCHED-DM-004)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    await openCreateDialog();

    await expectDialogPickerShowsModel("Kimi K2.5");
  });

  // SCHED-DM-005: When org admin switches the org default (e.g. Kimi ->
  // Sonnet via the org manage page), opening a fresh create dialog with
  // the new default-provider state shows the new default.
  it("shows an updated org default (Sonnet) for agents on org default (SCHED-DM-005)", async () => {
    mockOrgProviders({
      defaultProviderId: ANTHROPIC_PROVIDER_ID,
      defaultSelectedModel: "claude-sonnet-4-6",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    await openCreateDialog();

    await expectDialogPickerShowsModel("Claude Sonnet 4.6");
  });

  // SCHED-DM-006: Another non-org-default agent model (GLM-5.1) takes
  // priority over the org default (Kimi). Covers the third-provider path
  // so we're not over-fitting the test to a single Anthropic/Moonshot
  // pair.
  it("agent default (GLM-5.1) wins over a different org default (SCHED-DM-006)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({
      modelProviderId: ZAI_PROVIDER_ID,
      selectedModel: "glm-5.1",
    });

    await openCreateDialog();

    await expectDialogPickerShowsModel("GLM-5.1");
  });
});
