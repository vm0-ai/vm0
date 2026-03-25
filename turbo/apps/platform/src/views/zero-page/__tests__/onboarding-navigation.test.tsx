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
    await waitFor(
      () => {
        expect(pathname()).toBe("/onboarding");
      },
      { timeout: 5000 },
    );

    // Onboarding dialog should be rendered
    await waitFor(
      () => {
        expect(
          screen.getByText(/Meet Zero, your new teammate/),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  }, 15_000);

  it("should navigate to / after completing admin onboarding via web", async () => {
    mockOnboardingNeededAdmin();

    await setupPage({ context, path: "/onboarding" });

    // Step 1: Wait for welcome screen
    await waitFor(
      () => {
        expect(
          screen.getByText(/Meet Zero, your new teammate/),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Click Next to go to step 3 (connectors)
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Add connector")).toBeInTheDocument();
    });

    // Click Next to go to step 4 (where to work)
    fireEvent.click(screen.getAllByRole("button", { name: "Next" })[0]!);

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

    // Click "Chat with Zero" to trigger handleContinueWithWeb -> navigate("/")
    const chatWithZeroButton = screen.getByRole("button", {
      name: /Chat with Zero/,
    });
    fireEvent.click(chatWithZeroButton);

    // Verify navigation to / (which then redirects to /talk/:name)
    await waitFor(
      () => {
        expect(pathname()).not.toBe("/onboarding");
      },
      { timeout: 5000 },
    );
  }, 15_000);

  it("should redirect to /onboarding when member needs onboarding", async () => {
    mockOnboardingNeededMember();

    await setupPage({ context, path: "/" });

    // The / route should redirect to /onboarding
    await waitFor(
      () => {
        expect(pathname()).toBe("/onboarding");
      },
      { timeout: 5000 },
    );

    // Member welcome dialog should be rendered
    await waitFor(
      () => {
        expect(
          screen.getByText(/Meet .+, your new teammate/),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  }, 15_000);

  it("should navigate to / after completing member onboarding via web", async () => {
    mockOnboardingNeededMember();

    await setupPage({ context, path: "/onboarding" });

    // Step 1: Wait for member welcome screen
    await waitFor(
      () => {
        expect(
          screen.getByText(/Meet .+, your new teammate/),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // With no defaultAgentSkills, Next goes directly to "where" step
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

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

    // Click "Chat with zero" to trigger handleContinueWeb -> navigate("/")
    const chatButton = screen.getByRole("button", {
      name: /Chat with zero/i,
    });
    fireEvent.click(chatButton);

    // Verify navigation away from /onboarding (/ redirects to /talk/:name)
    await waitFor(
      () => {
        expect(pathname()).not.toBe("/onboarding");
      },
      { timeout: 5000 },
    );
  }, 15_000);
});
