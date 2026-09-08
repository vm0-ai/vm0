import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const LAST_USED_AGENT_STORAGE_KEY = "zero.lastUsedAgentId";
const { set$: setLastUsedAgentId$ } = localStorageSignals(
  LAST_USED_AGENT_STORAGE_KEY,
);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

const OTHER_ORG_AGENT_ID = "c0000000-0000-4000-a000-000000000004";
const CURRENT_ORG_AGENT_ID = "c0000000-0000-4000-a000-000000000005";
const STALE_AGENT_ID = "c0000000-0000-4000-a000-000000000006";

const UNVALIDATED_AGENT_CASES = [
  {
    candidateId: STALE_AGENT_ID,
    label: "stale",
    recoveryAgentId: DEFAULT_AGENT_ID,
    recoveryAgentName: "Default agent",
    switchedOrganization: false,
  },
  {
    candidateId: OTHER_ORG_AGENT_ID,
    label: "cross-organization",
    recoveryAgentId: CURRENT_ORG_AGENT_ID,
    recoveryAgentName: "Current organization agent",
    switchedOrganization: true,
  },
] as const;

function agentResponse(id: string, displayName: string): AgentResponse {
  return {
    agentId: id,
    ownerId: "user_mock",
    displayName,
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
}

function deferAgentsResponse(agents: AgentResponse[]) {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const responded = context.mocks.deferred<void>();
  context.mocks.api(agentsMainContract.list, async ({ respond }) => {
    started.resolve(undefined);
    await release.promise;
    const response = respond(200, agents);
    responded.resolve(undefined);
    return response;
  });
  return { release, responded, started };
}

function recordAgentDraftLoads(): () => readonly string[] {
  const agentIds: string[] = [];
  context.mocks.api(agentDraftContract.get, ({ params, respond }) => {
    agentIds.push(params.id);
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  return () => {
    return agentIds;
  };
}

function setupCandidateHomeRoute(
  candidate: (typeof UNVALIDATED_AGENT_CASES)[number],
): Promise<void> {
  return setupPage({
    context,
    path: "/",
    ...(candidate.switchedOrganization
      ? {
          auth: {
            user: { id: "test-user-123", fullName: "Test User" },
            organization: {
              activeOrg: {
                id: "org_current",
                name: "Current organization",
              },
              memberships: [{ id: "org_current" }, { id: "org_previous" }],
            },
          },
        }
      : {}),
  });
}

async function expectCandidateRecovery(
  candidate: (typeof UNVALIDATED_AGENT_CASES)[number],
): Promise<void> {
  context.store.set(setLastUsedAgentId$, candidate.candidateId);
  context.mocks.data.onboardingStatus({
    defaultAgentId: candidate.recoveryAgentId,
  });
  const draftLoads = recordAgentDraftLoads();
  const team = deferAgentsResponse([
    agentResponse(candidate.recoveryAgentId, candidate.recoveryAgentName),
  ]);

  await setupCandidateHomeRoute(candidate);

  await team.started.promise;
  expect(pathname()).toBe(`/agents/${candidate.candidateId}/chat`);
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(draftLoads()).not.toContain(candidate.candidateId);

  team.release.resolve(undefined);
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${candidate.recoveryAgentId}/chat`);
    expect(document.title).toContain(candidate.recoveryAgentName);
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(draftLoads()).not.toContain(candidate.candidateId);
}

test("An unavailable last-used agent recovers to an available agent", async () => {
  await expectCandidateRecovery(UNVALIDATED_AGENT_CASES[0]);
  expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
});

test("A last-used agent from another organization recovers within the active organization", async () => {
  await expectCandidateRecovery(UNVALIDATED_AGENT_CASES[1]);
  expect(pathname()).toBe(`/agents/${CURRENT_ORG_AGENT_ID}/chat`);
});
