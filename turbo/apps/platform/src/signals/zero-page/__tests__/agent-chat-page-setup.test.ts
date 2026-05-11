import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";
import { pathname, search } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  chatPageAgentModelDefault$,
  chatPageModelSelection$,
  setChatPageModelSelection$,
} from "../zero-chat-page.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { setMockUserModelPreference } from "../../../mocks/handlers/api-user-model-preference.ts";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../model-provider-default.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("agent chat page setup", () => {
  it("redirects unknown route agents to the default agent chat", async () => {
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    detachedSetupPage({
      context,
      path: "/agents/missing-agent/chat?prompt=hello",
      withoutRender: true,
    });

    await waitFor(() => {
      expect(pathname()).toBe(
        "/agents/c0000000-0000-4000-a000-000000000001/chat",
      );
      expect(search()).toBe("?prompt=hello");
    });
  });

  it("resets landing page model override on entry", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";
    const defaultProviderId = "00000000-0000-4000-a000-000000000001";

    setMockTeam([
      {
        id: agentId,
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    setMockOrgModelProviders([
      {
        id: defaultProviderId,
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
      {
        id: "00000000-0000-4000-a000-000000000002",
        type: "zai-api-key",
        framework: "claude-code",
        secretName: "ZAI_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: false,
        selectedModel: "glm-5.1",
        needsReconnect: false,
        lastRefreshErrorCode: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId,
          ownerId: "test-user-123",
          description: null,
          displayName: "Zero",
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
        });
      }),
    );

    context.store.set(setChatPageModelSelection$, {
      modelProviderId: "00000000-0000-4000-a000-000000000002",
      selectedModel: "glm-5.1",
    });

    await setupPage({
      context,
      path: `/agents/${agentId}/chat`,
      withoutRender: true,
    });

    await waitFor(async () => {
      await expect(
        context.store.get(chatPageModelSelection$),
      ).resolves.toStrictEqual({
        modelProviderId: defaultProviderId,
        selectedModel: "claude-sonnet-4-6",
      });
    });
  });

  it("refreshes model-first user preference on entry", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";

    setMockFeatureSwitches({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
    setMockTeam([
      {
        id: agentId,
        displayName: "Zero",
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
          agentId,
          ownerId: "test-user-123",
          description: null,
          displayName: "Zero",
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
        });
      }),
    );

    setMockUserModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });

    await setupPage({
      context,
      path: `/agents/${agentId}/chat`,
      withoutRender: true,
    });
    await waitFor(async () => {
      await expect(
        context.store.get(chatPageAgentModelDefault$),
      ).resolves.toStrictEqual({
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: "claude-sonnet-4-6",
      });
    });

    setMockUserModelPreference({
      selectedModel: "glm-5.1",
      updatedAt: "2026-03-10T00:01:00Z",
    });

    await setupPage({
      context,
      path: `/agents/${agentId}/chat`,
      withoutRender: true,
    });

    await waitFor(async () => {
      await expect(
        context.store.get(chatPageAgentModelDefault$),
      ).resolves.toStrictEqual({
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: "glm-5.1",
      });
    });
  });
});
