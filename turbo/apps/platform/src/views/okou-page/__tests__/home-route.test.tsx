import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { pathname } from "../../../signals/location.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";

const context = testContext();
const LAST_USED_AGENT_STORAGE_KEY = "zero.lastUsedAgentId";
const { set$: setLastUsedAgentId$, clear$: clearLastUsedAgentId$ } =
  localStorageSignals(LAST_USED_AGENT_STORAGE_KEY);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RETURNING_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
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

function blockUnexpectedTeamRequests(): void {
  context.mocks.api(agentsMainContract.list, ({ never }) => {
    return never();
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

test("The home route sets the title for the resolved agent", async () => {
  context.store.set(clearLastUsedAgentId$);
  context.mocks.data.onboardingStatus({
    defaultAgentId: DEFAULT_AGENT_ID,
  });
  const team = deferAgentsResponse([
    agentResponse(DEFAULT_AGENT_ID, "Default agent"),
  ]);
  const titleSetter = vi.spyOn(document, "title", "set");

  try {
    await setupPage({ context, path: "/" });

    await team.started.promise;
    expect(titleSetter).not.toHaveBeenCalled();

    team.release.resolve(undefined);
    await waitFor(() => {
      expect(document.title).toBe("Default agent | VM0");
    });
    expect(
      titleSetter.mock.calls.map(([title]) => {
        return title;
      }),
    ).toStrictEqual(["Default agent | VM0"]);
  } finally {
    titleSetter.mockRestore();
  }
});

test("A first-time user reaches the default agent without waiting for the full agent list", async () => {
  context.store.set(clearLastUsedAgentId$);
  context.mocks.data.onboardingStatus({
    defaultAgentId: DEFAULT_AGENT_ID,
  });
  const team = deferAgentsResponse([
    agentResponse(DEFAULT_AGENT_ID, "Default agent"),
  ]);

  await setupPage({ context, path: "/" });

  await team.started.promise;
  expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();

  team.release.resolve(undefined);
  await waitFor(() => {
    expect(document.title).toContain("Default agent");
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
});

test("A malformed last-agent value falls back to the default agent", async () => {
  context.store.set(setLastUsedAgentId$, "stale-agent-id");
  context.mocks.data.onboardingStatus({
    defaultAgentId: DEFAULT_AGENT_ID,
  });
  const team = deferAgentsResponse([
    agentResponse(DEFAULT_AGENT_ID, "Default agent"),
  ]);

  await setupPage({ context, path: "/" });

  await team.started.promise;
  expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
  team.release.resolve(undefined);
  await waitFor(() => {
    expect(document.title).toContain("Default agent");
  });
});

test("An unavailable last-used agent recovers to an available agent", async () => {
  await expectCandidateRecovery(UNVALIDATED_AGENT_CASES[0]);
  expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
});

test("A last-used agent from another organization recovers within the active organization", async () => {
  await expectCandidateRecovery(UNVALIDATED_AGENT_CASES[1]);
  expect(pathname()).toBe(`/agents/${CURRENT_ORG_AGENT_ID}/chat`);
});

test("Required onboarding takes priority over returning to an agent", async () => {
  context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    hasDefaultAgent: false,
    defaultAgentId: null,
    defaultAgentMetadata: null,
  });
  blockUnexpectedTeamRequests();

  await setupPage({ context, path: "/" });

  await expect(
    screen.findByRole("heading", { name: "What do you want to make first" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
});

test("Organization selection takes priority over returning to an agent", async () => {
  context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
  blockUnexpectedTeamRequests();

  await startPage({
    context,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: null,
        memberships: [{ id: "org_member" }],
      },
    },
    path: "/",
    host: "app.vm0.ai",
  });

  await waitFor(() => {
    expect(new URL(window.location.href).pathname).toBe(
      "/sign-in/tasks/choose-organization",
    );
  });
});

test("Sign-in takes priority over returning to an agent", async () => {
  context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
  blockUnexpectedTeamRequests();

  await startPage({
    context,
    path: "/",
    host: "app.vm0.ai",
    auth: null,
  });

  await waitFor(() => {
    expect(new URL(window.location.href).pathname).toBe("/sign-in");
  });
});

test("Late agent validation does not pull a user back after navigation", async () => {
  const draftLoads = recordAgentDraftLoads();
  const team = deferAgentsResponse([
    agentResponse(RETURNING_AGENT_ID, "Returning agent"),
  ]);
  await setupPage({
    context,
    path: `/agents/${RETURNING_AGENT_ID}/chat`,
  });

  await team.started.promise;
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();

  context.store.set(detachedNavigateTo$, ROUTES.skeleton, { replace: true });
  await waitFor(() => {
    expect(pathname()).toBe(ROUTES.skeleton);
  });
  team.release.resolve(undefined);
  await team.responded.promise;
  await waitFor(() => {
    expect(pathname()).toBe(ROUTES.skeleton);
  });
  expect(draftLoads()).not.toContain(RETURNING_AGENT_ID);
});

test("Late home-routing data does not undo a user's navigation", async () => {
  context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
  const onboardingRequestStarted = context.mocks.deferred<void>();
  const releaseOnboardingRequest = context.mocks.deferred<void>();
  const onboardingResponseReturned = context.mocks.deferred<void>();
  context.mocks.api(onboardingStatusContract.getStatus, async ({ respond }) => {
    onboardingRequestStarted.resolve(undefined);
    await releaseOnboardingRequest.promise;
    const response = respond(200, {
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: DEFAULT_AGENT_ID,
      defaultAgentMetadata: { displayName: "Default agent" },
    });
    onboardingResponseReturned.resolve(undefined);
    return response;
  });
  blockUnexpectedTeamRequests();

  await setupPage({
    context,
    path: "/",
  });
  await onboardingRequestStarted.promise;

  context.store.set(detachedNavigateTo$, ROUTES.skeleton, { replace: true });
  await waitFor(() => {
    expect(pathname()).toBe(ROUTES.skeleton);
  });

  releaseOnboardingRequest.resolve(undefined);
  await onboardingResponseReturned.promise;
  await waitFor(() => {
    expect(pathname()).toBe(ROUTES.skeleton);
  });
});
