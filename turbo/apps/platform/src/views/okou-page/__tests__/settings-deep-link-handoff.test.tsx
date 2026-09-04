import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const LAST_USED_AGENT_STORAGE_KEY = "zero.lastUsedAgentId";
const { set$: setLastUsedAgentId$, clear$: clearLastUsedAgentId$ } =
  localStorageSignals(LAST_USED_AGENT_STORAGE_KEY);

const DEFAULT_AGENT = {
  agentId: "c0000000-0000-4000-a000-000000000001",
  ownerId: "user_mock",
  displayName: "Zero",
  description: null,
  sound: null,
  avatarUrl: null,
  modelProviderId: null,
  selectedModel: null,
  preferPersonalProvider: false,
  visibility: "private",
} satisfies AgentResponse;

test("A Settings deep link waits for the stable home conversation", async () => {
  context.store.set(setLastUsedAgentId$, DEFAULT_AGENT.agentId);
  const agentsRequestStarted = context.mocks.deferred<void>();
  const releaseAgentsRequest = context.mocks.deferred<void>();
  context.mocks.api(agentsMainContract.list, async ({ respond }) => {
    agentsRequestStarted.resolve(undefined);
    await releaseAgentsRequest.promise;
    return respond(200, [DEFAULT_AGENT]);
  });

  await setupPage({
    context,
    path: "/?settings=billing&billingView=plans",
  });

  await agentsRequestStarted.promise;
  expect(
    screen.queryByRole("dialog", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();

  releaseAgentsRequest.resolve(undefined);

  await waitFor(() => {
    expect(window.location.pathname).toBe(
      `/agents/${DEFAULT_AGENT.agentId}/chat`,
    );
  });
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
});

test("A Settings deep link opens on the root page without a home agent", async () => {
  context.store.set(clearLastUsedAgentId$);
  context.mocks.data.onboardingStatus({
    hasDefaultAgent: false,
    defaultAgentId: null,
  });

  await setupPage({
    context,
    path: "/?settings=billing",
  });

  await expect(
    screen.findByRole("dialog", { name: "Settings" }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: "Billing" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
});
