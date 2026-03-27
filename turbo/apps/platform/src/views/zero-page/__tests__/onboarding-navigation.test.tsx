import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockOnboardingNeededAdmin() {
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
    // Mock org name update
    http.put("*/api/zero/org", () => {
      return HttpResponse.json({ success: true });
    }),
    // Mock model provider creation
    http.post("*/api/zero/model-providers", () => {
      return HttpResponse.json({ success: true }, { status: 201 });
    }),
    // Mock the agent creation endpoint
    http.post("*/api/zero/agents", () => {
      return HttpResponse.json(
        {
          name: "zero",
          agentId: "new-compose-id",
        },
        { status: 201 },
      );
    }),
    // Mock instructions upload
    http.put("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ success: true });
    }),
    // Mock setting default agent
    http.put("*/api/zero/default-agent", () => {
      return HttpResponse.json({ success: true });
    }),
    // Mock onboarding completion
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ success: true });
    }),
    // Mock chat threads for the home page
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    // Mock chat send for the auto-intro message
    http.post("*/api/zero/chat", () => {
      return HttpResponse.json({ threadId: "new-thread-1" });
    }),
  );
}

function mockOnboardingNeededMember() {
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
    // Mock complete member onboarding
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ success: true });
    }),
    // Mock chat threads for the home page
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    // Mock chat send for the auto-intro message
    http.post("*/api/zero/chat", () => {
      return HttpResponse.json({ threadId: "new-thread-1" });
    }),
  );
}

describe("onboarding navigation", () => {
  it("should redirect to /onboarding when admin needs onboarding", async () => {
    mockOnboardingNeededAdmin();

    await setupPage({ context, path: "/" });

    // The / route should redirect to /onboarding
    await waitFor(() => {
      expect(pathname()).toBe("/onboarding");
    });

    // Onboarding step 1 should be rendered
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });
  }, 15_000);

  it("should navigate to / after completing admin onboarding via web", async () => {
    mockOnboardingNeededAdmin();

    await setupPage({ context, path: "/onboarding" });

    // Step 1: Workspace name
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    // Fill name and advance
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

    // After completing onboarding, the API should report needsOnboarding: false
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

    // Click "Continue in web" to trigger handleContinueWithWeb -> navigate("/")
    const continueButton = screen.getByRole("button", {
      name: /Continue in web/,
    });
    fireEvent.click(continueButton);

    // Verify navigation to / (which then redirects to /talk/:name)
    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });
  }, 15_000);

  it("should redirect to /onboarding when member needs onboarding", async () => {
    mockOnboardingNeededMember();

    await setupPage({ context, path: "/" });

    // The / route should redirect to /onboarding
    await waitFor(() => {
      expect(pathname()).toBe("/onboarding");
    });

    // Member goes straight to step 4 (where-to-work) with no connectors
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });
  }, 15_000);

  it("should navigate to / after completing member onboarding via web", async () => {
    mockOnboardingNeededMember();

    await setupPage({ context, path: "/onboarding" });

    // Member with no connectors goes straight to step 4 (where-to-work)
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // After completing onboarding, the API should report needsOnboarding: false
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

    // Click "Continue in web" to trigger handleContinueWeb -> navigate("/")
    const chatButton = screen.getByRole("button", {
      name: /Continue in web/,
    });
    fireEvent.click(chatButton);

    // Verify navigation away from /onboarding (/ redirects to /talk/:name)
    await waitFor(() => {
      expect(pathname()).not.toBe("/onboarding");
    });
  }, 15_000);
});
