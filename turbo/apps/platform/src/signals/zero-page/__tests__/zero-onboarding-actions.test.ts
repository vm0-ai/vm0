import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  onboardingDisplayName$,
  onboardingAddToSlack$,
  onboardingContinueWeb$,
} from "../zero-onboarding-actions.ts";
import { setZeroAgentName$, zeroOnboardingStep$ } from "../zero-onboarding.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../utils.ts";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
const MOCK_MEMBER_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockAdminOnboarding() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
        defaultAgentSkills: [],
      });
    }),
  );
}

function mockMemberOnboarding() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MOCK_MEMBER_AGENT_ID,
        defaultAgentMetadata: { displayName: "TeamBot" },
        defaultAgentSkills: [],
      });
    }),
  );
}

function mockAdminCompletionApis() {
  server.use(
    http.post("*/api/zero/onboarding/setup", () => {
      return HttpResponse.json({ agentId: MOCK_AGENT_ID });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockMemberCompletionApis() {
  server.use(
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

// ---------------------------------------------------------------------------
// onboardingDisplayName$
// ---------------------------------------------------------------------------

describe("onboardingDisplayName$", () => {
  it("should return agent name for admin", async () => {
    mockAdminOnboarding();
    detachedSetupPage({ context, path: "/", withoutRender: true });

    context.store.set(setZeroAgentName$, "My Agent");

    const name = await context.store.get(onboardingDisplayName$);
    expect(name).toBe("My Agent");
  });
});

// ---------------------------------------------------------------------------
// onboardingAddToSlack$
// ---------------------------------------------------------------------------

describe("onboardingAddToSlack$", () => {
  it("should navigate to /works for admin", async () => {
    mockAdminOnboarding();
    mockAdminCompletionApis();

    // Switch status to complete after the first fetch (bootstrap reads once,
    // then completeOnboarding$ triggers a reload which should see "done").
    let adminStatusCalls = 0;
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        adminStatusCalls++;
        if (adminStatusCalls <= 1) {
          return HttpResponse.json({
            needsOnboarding: true,
            isAdmin: true,
            hasOrg: true,
            hasDefaultAgent: false,
            defaultAgentId: null,
            defaultAgentMetadata: null,
            defaultAgentSkills: [],
          });
        }
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: null,
          defaultAgentSkills: [],
        });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(onboardingAddToSlack$, context.signal);

    expect(pathname()).toBe("/works");
  });

  it("should navigate to /works for member", async () => {
    mockMemberOnboarding();
    mockMemberCompletionApis();

    // Switch status to complete after the first fetch
    let memberStatusCalls = 0;
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        memberStatusCalls++;
        if (memberStatusCalls <= 1) {
          return HttpResponse.json({
            needsOnboarding: true,
            isAdmin: false,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: MOCK_MEMBER_AGENT_ID,
            defaultAgentMetadata: { displayName: "TeamBot" },
            defaultAgentSkills: [],
          });
        }
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_MEMBER_AGENT_ID,
          defaultAgentMetadata: { displayName: "TeamBot" },
          defaultAgentSkills: [],
        });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(onboardingAddToSlack$, context.signal);

    expect(pathname()).toBe("/works");
  });
});

// ---------------------------------------------------------------------------
// onboardingContinueWeb$
// ---------------------------------------------------------------------------

describe("onboardingContinueWeb$", () => {
  it("should navigate to /agents/:id/chat for admin", async () => {
    mockAdminOnboarding();
    mockAdminCompletionApis();

    // Switch status to complete after the first fetch
    let adminStatusCalls = 0;
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        adminStatusCalls++;
        if (adminStatusCalls <= 1) {
          return HttpResponse.json({
            needsOnboarding: true,
            isAdmin: true,
            hasOrg: true,
            hasDefaultAgent: false,
            defaultAgentId: null,
            defaultAgentMetadata: null,
            defaultAgentSkills: [],
          });
        }
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: null,
          defaultAgentSkills: [],
        });
      }),
    );

    detachedSetupPage({ context, path: "/onboarding", withoutRender: true });

    await context.store.set(onboardingContinueWeb$, context.signal);

    expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    // Step is set to "done" by completeOnboarding$
    await expect(context.store.get(zeroOnboardingStep$)).resolves.toBe("done");
  });

  it("should navigate to /agents/:id/chat for member", async () => {
    mockMemberOnboarding();
    mockMemberCompletionApis();

    // Switch status to complete after the first fetch
    let memberStatusCalls = 0;
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        memberStatusCalls++;
        if (memberStatusCalls <= 1) {
          return HttpResponse.json({
            needsOnboarding: true,
            isAdmin: false,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: MOCK_MEMBER_AGENT_ID,
            defaultAgentMetadata: { displayName: "TeamBot" },
            defaultAgentSkills: [],
          });
        }
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_MEMBER_AGENT_ID,
          defaultAgentMetadata: { displayName: "TeamBot" },
          defaultAgentSkills: [],
        });
      }),
    );

    detachedSetupPage({ context, path: "/onboarding", withoutRender: true });

    await context.store.set(onboardingContinueWeb$, context.signal);

    expect(pathname()).toBe(`/agents/${MOCK_MEMBER_AGENT_ID}/chat`);
  });
});

// ---------------------------------------------------------------------------
// Concurrent invocation
// ---------------------------------------------------------------------------

describe("onboarding concurrent invocation", () => {
  it("should complete both invocations when continueWeb is invoked concurrently", async () => {
    mockAdminOnboarding();

    const deferred = createDeferredPromise<void>(context.signal);
    let requestCount = 0;

    // Switch status to complete after the first fetch
    let concurrentStatusCalls = 0;
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        concurrentStatusCalls++;
        if (concurrentStatusCalls <= 1) {
          return HttpResponse.json({
            needsOnboarding: true,
            isAdmin: true,
            hasOrg: true,
            hasDefaultAgent: false,
            defaultAgentId: null,
            defaultAgentMetadata: null,
            defaultAgentSkills: [],
          });
        }
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: null,
          defaultAgentSkills: [],
        });
      }),
      http.post("*/api/zero/onboarding/setup", async () => {
        requestCount++;
        // Hold the first request open until we release it
        await deferred.promise;
        return HttpResponse.json({ agentId: MOCK_AGENT_ID });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/onboarding", withoutRender: true });

    // Fire two concurrent invocations (simulates double-click)
    const first = context.store.set(onboardingContinueWeb$, context.signal);
    const second = context.store.set(onboardingContinueWeb$, context.signal);

    // Release the held request
    deferred.resolve();

    await Promise.all([first, second]);

    // Both invocations run (UI-level deduplication is handled by useLoadableSet)
    expect(requestCount).toBeGreaterThanOrEqual(1);
  });
});
