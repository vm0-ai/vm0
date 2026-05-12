/**
 * Schedule dialog model controls.
 *
 * Schedules no longer carry their own model choice. They inherit runtime model
 * resolution from the user preference first, then workspace default, so the
 * create dialog must not render a schedule-level Model picker.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockSchedules } from "../../../mocks/handlers/api-schedules.ts";
import {
  resetMockOrgModelPolicies,
  setMockOrgModelPolicies,
} from "../../../mocks/handlers/api-org-model-policies.ts";
import {
  resetMockUserModelPreference,
  setMockUserModelPreference,
} from "../../../mocks/handlers/api-user-model-preference.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  resetMockOnboardingStatus,
  setMockOnboardingStatus,
} from "../../../mocks/handlers/api-onboarding.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "e0000000-0000-4000-a000-000000000020";

function mockAgent() {
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
        modelProviderId: null,
        selectedModel: "claude-opus-4-7",
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

async function openCreateDialog() {
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

describe("schedule composer - model controls", () => {
  beforeEach(() => {
    resetMockOrgModelPolicies();
    resetMockUserModelPreference();
    resetMockOnboardingStatus();
    setMockFeatureSwitches({});
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
    mockAgent();
    setMockUserModelPreference({
      selectedModel: "glm-5.1",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    setMockOrgModelPolicies([
      {
        id: "00000000-0000-4000-a000-000000000301",
        model: "glm-5.1",
        modelLabel: "GLM-5.1",
        isDefault: false,
        defaultProviderType: "zai-api-key",
        credentialScope: "org",
        modelProviderId: "00000000-0000-4000-a000-000000000003",
        routeStatus: "valid",
        routeStatusReason: null,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
      },
    ]);
  });

  it("does not render a schedule-level model picker", async () => {
    await openCreateDialog();

    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /GLM-5\.1/i })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: /Claude Opus 4\.7/i }),
    ).toBeNull();
  });
});
