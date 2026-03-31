import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

/**
 * Mock onboarding as needed for an admin, plus chat lifecycle endpoints.
 * Returns control object from mockChatLifecycle and a spy for run creation.
 */
function mockAdminOnboardingWithChat() {
  let runCreated = false;

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
          agentId: "d0000000-0000-4000-a000-000000000001",
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
        agentId: "d0000000-0000-4000-a000-000000000001",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        connectors: [],
        firewallPolicies: null,
      });
    }),
    http.put("*/api/zero/default-agent", () => {
      return HttpResponse.json({
        agentId: "d0000000-0000-4000-a000-000000000001",
      });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
  );

  // mockChatLifecycle sets up the unified POST /api/zero/chat/messages handler
  // which also tracks the run prompt. We wrap it to detect intro message creation.
  const ctrl = mockChatLifecycle();

  // Use a request interceptor to detect when the intro message is sent
  server.events.on("request:match", ({ request }) => {
    if (
      request.method === "POST" &&
      request.url.includes("/api/zero/chat/messages")
    ) {
      runCreated = true;
    }
  });

  return {
    ctrl,
    wasRunCreated: () => runCreated,
    /** Switch onboarding status to completed (call before clicking "Continue in web") */
    completeOnboarding: () => {
      server.use(
        http.get("*/api/zero/onboarding/status", () => {
          return HttpResponse.json({
            needsOnboarding: false,
            isAdmin: true,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: "d0000000-0000-4000-a000-000000000001",
            defaultAgentMetadata: null,
            defaultAgentSkills: [],
          });
        }),
      );
    },
  };
}

/**
 * Mock onboarding as needed for a member, plus chat lifecycle endpoints.
 */
function mockMemberOnboardingWithChat() {
  let runCreated = false;

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

  const ctrl = mockChatLifecycle();

  server.events.on("request:match", ({ request }) => {
    if (
      request.method === "POST" &&
      request.url.includes("/api/zero/chat/messages")
    ) {
      runCreated = true;
    }
  });

  return {
    ctrl,
    wasRunCreated: () => runCreated,
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

/** Walk through onboarding steps up to the "Where would you like to work" step. */
async function walkToWhereStep(
  user: ReturnType<typeof userEvent.setup>,
  isMember: boolean,
) {
  if (isMember) {
    // Member with no connectors skips directly to step 4 (where-to-work)
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });
  } else {
    // Admin: step 1 (workspace name) → step 2 (choose tools) → step 3 (connect) → step 4 (where)
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    // Fill workspace name and advance
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Test Workspace");
    await user.click(screen.getByText("Next"));

    // Step 2: Choose your tools → Next
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    // Step 3: Connect your apps → Next
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    // Step 4: Where to work
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });
  }
}

describe("onboarding auto-intro message", () => {
  it("should send intro message after admin completes onboarding via web", async () => {
    const user = userEvent.setup();
    const mock = mockAdminOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });
    await walkToWhereStep(user, false);

    // Switch onboarding status so post-navigate route doesn't redirect back
    mock.completeOnboarding();

    await user.click(screen.getByRole("button", { name: /Continue in web/ }));

    // Verify navigation away from onboarding
    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });

    // Verify the agent run was actually created (intro message was sent)
    await waitFor(() => {
      expect(mock.wasRunCreated()).toBeTruthy();
    });

    // The assistant should be in thinking/running state
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Complete the run so the test cleans up
    mock.ctrl.completeRun("I am Zero, your AI teammate.");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  it("should send intro message after member completes onboarding via web", async () => {
    const user = userEvent.setup();
    const mock = mockMemberOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });
    await walkToWhereStep(user, true);

    mock.completeOnboarding();

    await user.click(screen.getByRole("button", { name: /Continue in web/ }));

    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });

    await waitFor(() => {
      expect(mock.wasRunCreated()).toBeTruthy();
    });

    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    mock.ctrl.completeRun("I am Zero, your AI teammate.");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  it("should allow follow-up messages after onboarding intro completes", async () => {
    const user = userEvent.setup();
    const mock = mockMemberOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });
    await walkToWhereStep(user, true);

    mock.completeOnboarding();

    await user.click(screen.getByRole("button", { name: /Continue in web/ }));

    // Wait for intro run to start
    await waitFor(() => {
      expect(mock.wasRunCreated()).toBeTruthy();
    });

    // Complete the intro run
    mock.ctrl.completeRun("I am Zero, your AI teammate.");

    // Wait for the chat to be ready for input
    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    // Verify the textarea is interactive (user can type a follow-up)
    expect(textarea).not.toBeDisabled();
  });
});
