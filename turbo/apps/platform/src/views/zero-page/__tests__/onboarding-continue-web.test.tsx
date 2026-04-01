import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
const MOCK_THREAD_ID = "thread-test-1";

function mockAdminOnboardingApis() {
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
    http.put("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "test-workspace",
        name: "Test Workspace",
      });
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
          ownerId: "test-owner-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          firewallPolicies: null,
        },
        { status: 201 },
      );
    }),
    http.put("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({
        name: "zero",
        agentId: MOCK_AGENT_ID,
        ownerId: "test-owner-id",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        connectors: [],
        firewallPolicies: null,
      });
    }),
    http.put("*/api/zero/default-agent", () => {
      return HttpResponse.json({ agentId: MOCK_AGENT_ID });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
  );
}

function switchToOnboardingComplete() {
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
}

function mockAdminOnboardingWithChat() {
  mockAdminOnboardingApis();
  const ctrl = mockChatLifecycle({ threadId: MOCK_THREAD_ID });

  return {
    ctrl,
    completeOnboarding: switchToOnboardingComplete,
  };
}

function mockMemberOnboardingWithChat() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
  );

  const ctrl = mockChatLifecycle({ threadId: MOCK_THREAD_ID });

  return {
    ctrl,
    completeOnboarding: () => {
      server.use(
        http.get("*/api/zero/onboarding/status", () => {
          return HttpResponse.json({
            needsOnboarding: false,
            isAdmin: false,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: "c0000000-0000-4000-a000-000000000001",
            defaultAgentMetadata: { displayName: "Zero" },
            defaultAgentSkills: [],
          });
        }),
      );
    },
  };
}

async function walkAdminToWhereStep(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await user.clear(input);
  await user.type(input, "Test Workspace");
  await user.click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByText("Choose your tools")).toBeInTheDocument();
  });
  await user.click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByText("Connect your apps")).toBeInTheDocument();
  });
  await user.click(screen.getByText("Next"));

  await waitFor(() => {
    expect(
      screen.getByText(/Where would you like to work with/),
    ).toBeInTheDocument();
  });
}

describe("onboarding continue in web → chat page", () => {
  it("should navigate to /chat/:threadId after admin completes full onboarding", async () => {
    const user = userEvent.setup();
    const mock = mockAdminOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep(user);

    mock.completeOnboarding();

    await user.click(screen.getByRole("button", { name: /Continue in web/ }));

    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${MOCK_THREAD_ID}`);
    });

    mock.ctrl.completeRun("I am Zero, your AI teammate.");
  });

  it("should navigate to /chat/:threadId after member completes onboarding", async () => {
    const user = userEvent.setup();
    const mock = mockMemberOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });

    // Member with no connectors skips directly to step 4
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    mock.completeOnboarding();

    await user.click(screen.getByRole("button", { name: /Continue in web/ }));

    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${MOCK_THREAD_ID}`);
    });

    mock.ctrl.completeRun("I am Zero, your AI teammate.");
  });
});

// ---------------------------------------------------------------------------
// Continue in Slack
// ---------------------------------------------------------------------------

function mockMemberOnboardingForSlack() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
  );

  return {
    completeOnboarding: () => {
      server.use(
        http.get("*/api/zero/onboarding/status", () => {
          return HttpResponse.json({
            needsOnboarding: false,
            isAdmin: false,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: "c0000000-0000-4000-a000-000000000001",
            defaultAgentMetadata: { displayName: "Zero" },
            defaultAgentSkills: [],
          });
        }),
      );
    },
  };
}

describe("onboarding add to Slack → works page", () => {
  it("should navigate to /works after admin completes onboarding via Slack", async () => {
    const user = userEvent.setup();
    mockAdminOnboardingApis();

    await setupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep(user);

    switchToOnboardingComplete();

    await user.click(screen.getByRole("button", { name: /Add .+ to Slack/ }));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
  });

  it("should navigate to /works after member completes onboarding via Slack", async () => {
    const user = userEvent.setup();
    const mock = mockMemberOnboardingForSlack();

    await setupPage({ context, path: "/onboarding" });

    // Member with no connectors skips directly to step 4
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    mock.completeOnboarding();

    await user.click(screen.getByRole("button", { name: /Add .+ to Slack/ }));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
  });
});
