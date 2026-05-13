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
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import { resetMockOrgModelPolicies } from "../../../mocks/handlers/api-org-model-policies.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

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

async function openProfileTab() {
  detachedSetupPage({ context, path: "/agents/my-agent" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
  click(screen.getByText(/Profile/i));
  await waitFor(() => {
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });
}

describe("model-provider-picker - display with null value", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockOrgModelPolicies();
  });

  it("does not render the legacy agent provider picker", async () => {
    setupMockAgent();
    setMockFeatureSwitches({});
    setMockOrgModelProviders([]);

    await openProfileTab();

    await waitFor(() => {
      expect(
        screen.queryByRole("combobox", { name: /Claude Sonnet 4\.6/ }),
      ).not.toBeInTheDocument();
    });
  });
});
