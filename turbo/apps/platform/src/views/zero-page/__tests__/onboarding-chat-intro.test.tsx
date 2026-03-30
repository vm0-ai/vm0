import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
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
      return HttpResponse.json({ success: true });
    }),
    http.post("*/api/zero/model-providers", () => {
      return HttpResponse.json({ success: true }, { status: 201 });
    }),
    http.post("*/api/zero/agents", () => {
      return HttpResponse.json(
        { name: "zero", agentId: "new-compose-id" },
        { status: 201 },
      );
    }),
    http.put("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ success: true });
    }),
    http.put("*/api/zero/default-agent", () => {
      return HttpResponse.json({ success: true });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ success: true });
    }),
  );

  const ctrl = mockChatLifecycle();

  // Intercept run creation to track whether the intro message was sent
  server.use(
    http.post("*/api/zero/runs", async ({ request }) => {
      runCreated = true;
      const body = (await request.json()) as { prompt: string };
      // Verify the auto-intro prompt
      expect(body.prompt).toBe("Who are you and what can you do?");
      return HttpResponse.json({ runId: "run-test-1" }, { status: 201 });
    }),
  );

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
            defaultAgentId: "new-compose-id",
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
        defaultAgentId: "mock-compose-id",
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ success: true });
    }),
  );

  const ctrl = mockChatLifecycle();

  server.use(
    http.post("*/api/zero/runs", async ({ request }) => {
      runCreated = true;
      const body = (await request.json()) as { prompt: string };
      expect(body.prompt).toBe("Who are you and what can you do?");
      return HttpResponse.json({ runId: "run-test-1" }, { status: 201 });
    }),
  );

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
            defaultAgentId: "mock-compose-id",
            defaultAgentMetadata: { displayName: "Zero" },
            defaultAgentSkills: [],
          });
        }),
      );
    },
  };
}

/** Walk through onboarding steps up to the "Where would you like to work" step. */
async function walkToWhereStep(isMember: boolean) {
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
    fireEvent.change(input, { target: { value: "Test Workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // Step 2: Choose your tools → Next
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Next" })[0]!);

    // Step 3: Connect your apps → Next
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Next" })[0]!);

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
    const mock = mockAdminOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });
    await walkToWhereStep(false);

    // Switch onboarding status so post-navigate route doesn't redirect back
    mock.completeOnboarding();

    fireEvent.click(screen.getByRole("button", { name: /Continue in web/ }));

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
    const mock = mockMemberOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });
    await walkToWhereStep(true);

    mock.completeOnboarding();

    fireEvent.click(screen.getByRole("button", { name: /Continue in web/ }));

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
    const mock = mockMemberOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });
    await walkToWhereStep(true);

    mock.completeOnboarding();

    fireEvent.click(screen.getByRole("button", { name: /Continue in web/ }));

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
