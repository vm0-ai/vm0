import { describe, expect, it } from "vitest";
import { onboardingCompleteContract, zeroAgentsByIdContract } from "@vm0/core";
import { server } from "../../mocks/server.ts";
import { mockApi } from "../../mocks/msw-contract.ts";
import { setMockOnboardingStatus } from "../../mocks/handlers/api-onboarding.ts";
import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { testContext } from "./test-helpers.ts";
import {
  agentById,
  defaultAgentName$,
  leadAgentAvatarUrl$,
  reloadAgentById$,
} from "../agent.ts";
import { zeroJobUpdateSettings$ } from "../zero-page/job-detail/settings.ts";
import { deleteZeroJobAgent$ } from "../zero-page/job-detail/delete.ts";
import {
  setActiveAgent$,
  zeroJobDetail$,
} from "../zero-page/zero-job-detail.ts";
import { completeOnboarding$ } from "../zero-page/zero-onboarding-actions.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

interface AgentOverrides {
  displayName?: string | null;
  avatarUrl?: string | null;
  selectedModel?: string | null;
}

function mockAgentResponse(overrides: AgentOverrides = {}) {
  return {
    agentId: AGENT_ID,
    ownerId: "test-owner-id",
    description: null,
    displayName: null,
    sound: null,
    avatarUrl: null,
    permissionPolicies: null,
    customSkills: [],
    modelProviderId: null,
    selectedModel: null,
    ...overrides,
  };
}

/**
 * Install a GET /api/zero/agents/:id handler that serves whatever the caller
 * most recently placed in the mutable `state` box. Every invocation is counted
 * so tests can assert how many times `agentById()` refetched.
 */
function serveAgent(state: { current: AgentOverrides }): { getCalls: number } {
  const counter = { getCalls: 0 };
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      counter.getCalls += 1;
      return respond(200, mockAgentResponse(state.current));
    }),
  );
  return counter;
}

describe("agentById$ cache invalidation", () => {
  it("returns the fresh response after reloadAgentById$ is dispatched", async () => {
    const state = { current: { displayName: "Old Name" } as AgentOverrides };
    const counter = serveAgent(state);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    // `agentById()` is memoized — the same computed is returned for the same
    // id so ccstate's caching logic applies and repeated reads do not refetch.
    const agent$ = agentById(AGENT_ID);

    const first = await context.store.get(agent$);
    expect(first.displayName).toBe("Old Name");
    expect(counter.getCalls).toBe(1);

    // Re-reading the same computed must not refetch — this is the baseline
    // the reload counter gates on.
    await context.store.get(agent$);
    expect(counter.getCalls).toBe(1);

    // Simulate a server-side mutation (e.g. PATCH by some other tab/device)
    // and then bump the counter to mirror what agent mutation commands do.
    state.current = { displayName: "New Name" };
    context.store.set(reloadAgentById$);

    const third = await context.store.get(agent$);
    expect(third.displayName).toBe("New Name");
    expect(counter.getCalls).toBe(2);
  });
});

describe("leadAgentAvatarUrl$", () => {
  it("derives from the default agent so it invalidates with reloadAgentById$", async () => {
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
    const state = {
      current: { avatarUrl: "https://example.com/a.png" } as AgentOverrides,
    };
    const counter = serveAgent(state);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const first = await context.store.get(leadAgentAvatarUrl$);
    expect(first).toBe("https://example.com/a.png");
    const callsBeforeReload = counter.getCalls;

    state.current = { avatarUrl: "https://example.com/b.png" };
    context.store.set(reloadAgentById$);

    const second = await context.store.get(leadAgentAvatarUrl$);
    // Regression: previously `leadAgentAvatarUrl$` had its own direct API call
    // with no invalidation and would have returned the stale value.
    expect(second).toBe("https://example.com/b.png");
    expect(counter.getCalls).toBeGreaterThan(callsBeforeReload);
  });

  it("returns null when there is no default agent", async () => {
    setMockOnboardingStatus({ defaultAgentId: null });

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const avatar = await context.store.get(leadAgentAvatarUrl$);
    expect(avatar).toBeNull();
  });

  it("updates defaultAgentName$ after reloadAgentById$ because it shares agentById", async () => {
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
    const state = {
      current: { displayName: "Zero" } as AgentOverrides,
    };
    serveAgent(state);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await expect(context.store.get(defaultAgentName$)).resolves.toBe("Zero");

    state.current = { displayName: "Renamed" };
    context.store.set(reloadAgentById$);

    await expect(context.store.get(defaultAgentName$)).resolves.toBe("Renamed");
  });
});

describe("agent mutations trigger reloadAgentById$", () => {
  it("zeroJobUpdateSettings$ invalidates agentById so a later read refetches", async () => {
    const state = { current: { displayName: "Old" } as AgentOverrides };
    const counter = serveAgent(state);
    server.use(
      mockApi(zeroAgentsByIdContract.updateMetadata, ({ respond }) => {
        return respond(200, mockAgentResponse({ displayName: "Updated" }));
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });
    context.store.set(setActiveAgent$, AGENT_ID);
    await context.store.get(zeroJobDetail$);

    // Prime the agentById cache before the mutation so we can observe the
    // invalidation (rather than a first-read miss).
    const before = await context.store.get(agentById(AGENT_ID));
    expect(before.displayName).toBe("Old");
    const callsBeforeMutation = counter.getCalls;

    state.current = { displayName: "Updated" };
    await context.store.set(
      zeroJobUpdateSettings$,
      { displayName: "Updated" },
      context.signal,
    );

    const after = await context.store.get(agentById(AGENT_ID));
    expect(after.displayName).toBe("Updated");
    expect(counter.getCalls).toBeGreaterThan(callsBeforeMutation);
  });

  it("deleteZeroJobAgent$ invalidates agentById so a later read refetches", async () => {
    const state = { current: { displayName: "Doomed" } as AgentOverrides };
    const counter = serveAgent(state);
    server.use(
      mockApi(zeroAgentsByIdContract.delete, ({ respond }) => {
        return respond(204);
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });
    context.store.set(setActiveAgent$, AGENT_ID);
    await context.store.get(zeroJobDetail$);

    const before = await context.store.get(agentById(AGENT_ID));
    expect(before.displayName).toBe("Doomed");
    const callsBeforeMutation = counter.getCalls;

    await context.store.set(deleteZeroJobAgent$, context.signal);

    await context.store.get(agentById(AGENT_ID));
    // The only guarantee we need from the fix: reloadAgentById$ was bumped so
    // any consumer still subscribed to agentById(deletedId) re-reads and sees
    // the server's post-delete state instead of the cached pre-delete body.
    expect(counter.getCalls).toBeGreaterThan(callsBeforeMutation);
  });

  it("completeOnboarding$ invalidates agentById so a later read refetches", async () => {
    // Use the member-onboarding path (needsOnboarding + hasDefaultAgent) so the
    // test does not need to exercise the Clerk JWT-refresh logic from the admin
    // path — the important assertion is that completeOnboarding$ bumps
    // reloadAgentById$ regardless of which branch runs.
    setMockOnboardingStatus({
      needsOnboarding: true,
      hasDefaultAgent: true,
      defaultAgentId: AGENT_ID,
    });
    server.use(
      mockApi(onboardingCompleteContract.complete, ({ respond }) => {
        return respond(200, { ok: true });
      }),
    );

    const state = { current: { displayName: "Before" } as AgentOverrides };
    const counter = serveAgent(state);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    // Prime the agentById cache so we can observe the invalidation.
    const before = await context.store.get(agentById(AGENT_ID));
    expect(before.displayName).toBe("Before");
    const callsBeforeMutation = counter.getCalls;

    state.current = { displayName: "After" };
    await context.store.set(completeOnboarding$, context.signal);

    const after = await context.store.get(agentById(AGENT_ID));
    expect(after.displayName).toBe("After");
    expect(counter.getCalls).toBeGreaterThan(callsBeforeMutation);
  });
});
