import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  onboardingDisplayName$,
  onboardingError$,
  onboardingAddToSlack$,
  onboardingContinueWeb$,
} from "../zero-onboarding-actions.ts";
import {
  setZeroAgentName$,
  zeroOnboardingStep$,
  zeroSaving$,
} from "../zero-onboarding.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

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
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: { displayName: "TeamBot" },
        defaultAgentSkills: [],
      });
    }),
  );
}

function mockAdminCompletionApis() {
  server.use(
    http.put("*/api/zero/org", () => {
      return HttpResponse.json({ id: "org_1", slug: "test", name: "Test" });
    }),
    http.post("*/api/zero/model-providers", () => {
      return HttpResponse.json(
        {
          provider: {
            id: "a0000000-0000-4000-a000-000000000099",
            type: "vm0",
            framework: "claude-code",
            secretName: null,
            authMethod: null,
            secretNames: null,
            isDefault: true,
            selectedModel: null,
            createdAt: "2026-03-01T00:00:00Z",
            updatedAt: "2026-03-01T00:00:00Z",
          },
          created: true,
        },
        { status: 201 },
      );
    }),
    http.post("*/api/zero/agents", () => {
      return HttpResponse.json(
        {
          name: "zero",
          agentId: MOCK_AGENT_ID,
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          firewallPolicies: null,
        },
        { status: 201 },
      );
    }),
    http.put(`*/api/zero/agents/${MOCK_AGENT_ID}/instructions`, () => {
      return HttpResponse.json({
        name: "zero",
        agentId: MOCK_AGENT_ID,
        ownerId: "test-user-123",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        firewallPolicies: null,
      });
    }),
    http.put("*/api/zero/default-agent", () => {
      return HttpResponse.json({ agentId: MOCK_AGENT_ID });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
    http.post("*/api/zero/chat/messages", () => {
      return HttpResponse.json(
        {
          runId: "run-1",
          threadId: "thread-1",
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        },
        { status: 201 },
      );
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
    http.post("*/api/zero/chat/messages", () => {
      return HttpResponse.json(
        {
          runId: "run-1",
          threadId: "thread-1",
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        },
        { status: 201 },
      );
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
    await setupPage({ context, path: "/", withoutRender: true });

    context.store.set(setZeroAgentName$, "My Agent");

    const name = await context.store.get(onboardingDisplayName$);
    expect(name).toBe("My Agent");
  });

  it("should return default agent display name for member", async () => {
    mockMemberOnboarding();
    await setupPage({ context, path: "/", withoutRender: true });

    const name = await context.store.get(onboardingDisplayName$);
    expect(name).toBe("TeamBot");
  });
});

// ---------------------------------------------------------------------------
// onboardingError$
// ---------------------------------------------------------------------------

describe("onboardingError$", () => {
  it("should return null for member even if error exists", async () => {
    mockMemberOnboarding();
    await setupPage({ context, path: "/", withoutRender: true });

    const error = await context.store.get(onboardingError$);
    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onboardingAddToSlack$
// ---------------------------------------------------------------------------

describe("onboardingAddToSlack$", () => {
  it("should navigate to /works for admin", async () => {
    mockAdminOnboarding();
    mockAdminCompletionApis();
    await setupPage({ context, path: "/", withoutRender: true });

    // Switch status to complete after the command runs
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
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

    await context.store.set(onboardingAddToSlack$, context.signal);

    expect(pathname()).toBe("/works");
    expect(context.store.get(zeroSaving$)).toBeFalsy();
  });

  it("should navigate to /works for member", async () => {
    mockMemberOnboarding();
    mockMemberCompletionApis();
    await setupPage({ context, path: "/", withoutRender: true });

    // Switch status to complete
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: "c0000000-0000-4000-a000-000000000001",
          defaultAgentMetadata: { displayName: "TeamBot" },
          defaultAgentSkills: [],
        });
      }),
    );

    await context.store.set(onboardingAddToSlack$, context.signal);

    expect(pathname()).toBe("/works");
  });
});

// ---------------------------------------------------------------------------
// onboardingContinueWeb$
// ---------------------------------------------------------------------------

describe("onboardingContinueWeb$", () => {
  it("should navigate to / and reset saving for admin", async () => {
    mockAdminOnboarding();
    mockAdminCompletionApis();
    await setupPage({ context, path: "/onboarding", withoutRender: true });

    // Switch status to complete
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
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

    await context.store.set(onboardingContinueWeb$, context.signal);

    expect(pathname()).toBe("/");
    expect(context.store.get(zeroSaving$)).toBeFalsy();
    // Step is set to "done" by dismissZeroOnboarding$
    await expect(context.store.get(zeroOnboardingStep$)).resolves.toBe("done");
  });

  it("should navigate to / for member", async () => {
    mockMemberOnboarding();
    mockMemberCompletionApis();
    await setupPage({ context, path: "/onboarding", withoutRender: true });

    // Switch status to complete
    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: "c0000000-0000-4000-a000-000000000001",
          defaultAgentMetadata: { displayName: "TeamBot" },
          defaultAgentSkills: [],
        });
      }),
    );

    await context.store.set(onboardingContinueWeb$, context.signal);

    expect(pathname()).toBe("/");
  });
});
