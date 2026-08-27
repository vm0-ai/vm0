import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { pathname } from "../../../signals/location.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { isAbortError } from "../../../signals/utils.ts";

const context = testContext();
const LAST_USED_AGENT_STORAGE_KEY = "zero.lastUsedAgentId";
const { set$: setLastUsedAgentId$, clear$: clearLastUsedAgentId$ } =
  localStorageSignals(LAST_USED_AGENT_STORAGE_KEY);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RETURNING_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const DELETED_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
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
    candidateId: DELETED_AGENT_ID,
    label: "deleted",
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
  context.mocks.api(agentsMainContract.list, async ({ respond }) => {
    started.resolve(undefined);
    await release.promise;
    return respond(200, agents);
  });
  return { release, started };
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
): void {
  detachedSetupPage({
    context,
    path: "/",
    ...(candidate.switchedOrganization
      ? {
          org: {
            activeOrg: {
              id: "org_current",
              name: "Current organization",
            },
            memberships: [{ id: "org_current" }, { id: "org_previous" }],
          },
        }
      : {}),
  });
}

function blockUnexpectedTeamRequests(): () => number {
  let requestCount = 0;
  context.mocks.api(agentsMainContract.list, ({ never }) => {
    requestCount += 1;
    return never();
  });
  return () => {
    return requestCount;
  };
}

function installBootstrapSkeleton(): HTMLDivElement {
  const skeleton = document.createElement("div");
  skeleton.id = "app-bootstrap-skeleton";
  document.body.append(skeleton);
  context.signal.addEventListener("abort", () => {
    skeleton.remove();
  });
  return skeleton;
}

describe("home route", () => {
  it("sets the resolved agent document title without an intermediate title", async () => {
    context.store.set(clearLastUsedAgentId$);
    context.mocks.data.onboardingStatus({
      defaultAgentId: DEFAULT_AGENT_ID,
    });
    const team = deferAgentsResponse([
      agentResponse(DEFAULT_AGENT_ID, "Default agent"),
    ]);
    const titleSetter = vi.spyOn(document, "title", "set");

    try {
      detachedSetupPage({ context, path: "/" });

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

  it("routes a first-time user to the default agent before the agents list resolves", async () => {
    context.store.set(clearLastUsedAgentId$);
    context.mocks.data.onboardingStatus({
      defaultAgentId: DEFAULT_AGENT_ID,
    });
    const team = deferAgentsResponse([
      agentResponse(DEFAULT_AGENT_ID, "Default agent"),
    ]);

    detachedSetupPage({ context, path: "/" });

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

  it("shows a returning user's persisted agent route before team validation resolves", async () => {
    context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
    const bootstrapSkeleton = installBootstrapSkeleton();
    const team = deferAgentsResponse([
      agentResponse(DEFAULT_AGENT_ID, "Default agent"),
      agentResponse(RETURNING_AGENT_ID, "Returning agent"),
    ]);

    detachedSetupPage({ context, path: "/" });

    await team.started.promise;
    expect(pathname()).toBe(`/agents/${RETURNING_AGENT_ID}/chat`);
    expect(bootstrapSkeleton).toHaveClass("app-bootstrap-skeleton--hidden");
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();

    team.release.resolve(undefined);
    await waitFor(() => {
      expect(document.title).toContain("Returning agent");
    });
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();
  });

  it("ignores a malformed stale persisted ID", async () => {
    context.store.set(setLastUsedAgentId$, "stale-agent-id");
    context.mocks.data.onboardingStatus({
      defaultAgentId: DEFAULT_AGENT_ID,
    });
    const team = deferAgentsResponse([
      agentResponse(DEFAULT_AGENT_ID, "Default agent"),
    ]);

    detachedSetupPage({ context, path: "/" });

    await team.started.promise;
    expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
    team.release.resolve(undefined);
    await waitFor(() => {
      expect(document.title).toContain("Default agent");
    });
  });

  it.each(UNVALIDATED_AGENT_CASES)(
    "shows a $label persisted candidate while validation resolves",
    async (candidate) => {
      context.store.set(setLastUsedAgentId$, candidate.candidateId);
      context.mocks.data.onboardingStatus({
        defaultAgentId: candidate.recoveryAgentId,
      });
      const draftLoads = recordAgentDraftLoads();
      const team = deferAgentsResponse([
        agentResponse(candidate.recoveryAgentId, candidate.recoveryAgentName),
      ]);

      setupCandidateHomeRoute(candidate);

      await team.started.promise;
      expect(pathname()).toBe(`/agents/${candidate.candidateId}/chat`);
      await expect(
        screen.findByRole("textbox", { name: "Message" }),
      ).resolves.toBeInTheDocument();
      const pageMain = document.querySelector("main");
      expect(pageMain).not.toBeNull();
      expect(draftLoads()).not.toContain(candidate.candidateId);

      team.release.resolve(undefined);
      await waitFor(() => {
        expect(pathname()).toBe(`/agents/${candidate.recoveryAgentId}/chat`);
        expect(document.title).toContain(candidate.recoveryAgentName);
      });
      expect(document.querySelector("main")).toBe(pageMain);
      expect(draftLoads()).not.toContain(candidate.candidateId);
    },
  );

  it("keeps onboarding ahead of persisted-agent navigation", async () => {
    context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
    const teamRequestCount = blockUnexpectedTeamRequests();

    detachedSetupPage({ context, path: "/" });

    await expect(
      screen.findByRole("heading", { name: "What do you want to make first" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe(ROUTES.onboarding);
    expect(teamRequestCount()).toBe(0);
  });

  it("keeps organization selection ahead of persisted-agent navigation", async () => {
    context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
    context.mocks.browser.url("https://app.vm0.ai/");
    const teamRequestCount = blockUnexpectedTeamRequests();

    detachedSetupPage({
      context,
      org: {
        activeOrg: null,
        memberships: [{ id: "org_member" }],
      },
      path: "/",
    });

    await waitFor(() => {
      expect(new URL(window.location.href).pathname).toBe(
        "/sign-in/tasks/choose-organization",
      );
    });
    expect(teamRequestCount()).toBe(0);
  });

  it("keeps authentication ahead of persisted-agent navigation", async () => {
    context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
    context.mocks.browser.url("https://app.vm0.ai/");
    const teamRequestCount = blockUnexpectedTeamRequests();

    detachedSetupPage({
      context,
      path: "/",
      session: null,
      user: null,
    });

    await waitFor(() => {
      expect(new URL(window.location.href).pathname).toBe("/sign-in");
    });
    expect(teamRequestCount()).toBe(0);
  });

  it("does not resume agent validation after navigation is aborted", async () => {
    const draftLoads = recordAgentDraftLoads();
    const team = deferAgentsResponse([
      agentResponse(RETURNING_AGENT_ID, "Returning agent"),
    ]);
    const setupPromise = setupPage({
      context,
      path: `/agents/${RETURNING_AGENT_ID}/chat`,
    });
    context.track(setupPromise);

    await team.started.promise;
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();

    context.store.set(detachedNavigateTo$, ROUTES.skeleton, { replace: true });
    await waitFor(() => {
      expect(pathname()).toBe(ROUTES.skeleton);
    });
    team.release.resolve(undefined);

    let setupError: unknown;
    try {
      await setupPromise;
    } catch (error: unknown) {
      setupError = error;
    }
    expect(isAbortError(setupError)).toBeTruthy();
    expect(pathname()).toBe(ROUTES.skeleton);
    expect(draftLoads()).not.toContain(RETURNING_AGENT_ID);
  });

  it("does not redirect after the home navigation lifecycle is aborted", async () => {
    context.store.set(setLastUsedAgentId$, RETURNING_AGENT_ID);
    const onboardingRequestStarted = context.mocks.deferred<void>();
    const releaseOnboardingRequest = context.mocks.deferred<void>();
    context.mocks.api(
      onboardingStatusContract.getStatus,
      async ({ respond }) => {
        onboardingRequestStarted.resolve(undefined);
        await releaseOnboardingRequest.promise;
        return respond(200, {
          needsOnboarding: false,
          onboardingComplete: true,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: DEFAULT_AGENT_ID,
          defaultAgentMetadata: { displayName: "Default agent" },
        });
      },
    );
    const teamRequestCount = blockUnexpectedTeamRequests();

    const setupPromise = setupPage({
      context,
      path: "/",
    });
    context.track(setupPromise);
    await onboardingRequestStarted.promise;
    await waitFor(() => {
      expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
    });

    context.store.set(detachedNavigateTo$, ROUTES.skeleton, { replace: true });
    await waitFor(() => {
      expect(pathname()).toBe(ROUTES.skeleton);
    });

    releaseOnboardingRequest.resolve(undefined);
    let setupError: unknown;
    try {
      await setupPromise;
    } catch (error: unknown) {
      setupError = error;
    }
    expect(isAbortError(setupError)).toBeTruthy();
    expect(pathname()).toBe(ROUTES.skeleton);
    expect(teamRequestCount()).toBe(0);
  });
});
