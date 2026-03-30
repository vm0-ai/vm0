import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockOnboardingNeeded() {
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

async function renderOnboardingPage() {
  await setupPage({ context, path: "/" });
}

describe("zero onboarding - step 1: workspace name", () => {
  it("should render workspace name step when onboarding is needed", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });
  });

  it("should show Next button in step 1", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    });
  });

  it("should advance to connector selection when Next is clicked", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    });

    // Fill in workspace name so Next is enabled
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    fireEvent.change(input, { target: { value: "Test Workspace" } });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
  });
});

describe("zero onboarding - step 2: choose tools", () => {
  it("should show connector selection with search", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Step 1 -> fill name -> Next
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    fireEvent.change(input, { target: { value: "Test Workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // Should reach step 2 (choose tools)
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    expect(screen.getByText(/Select the apps you use/)).toBeInTheDocument();
  });
});

describe("zero onboarding - does not render when not needed", () => {
  it("should not show onboarding dialog when needsOnboarding is false", async () => {
    // Default mock handler already returns needsOnboarding: false
    await renderOnboardingPage();

    // Wait for page to load and verify onboarding is NOT shown
    await waitFor(() => {
      expect(screen.queryByText(/Name your workspace/)).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Member Welcome (non-admin onboarding)
// ---------------------------------------------------------------------------

function mockMemberOnboardingNeeded() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "mock-compose-id",
        defaultAgentMetadata: null,
        defaultAgentSkills: [],
      });
    }),
  );
}

describe("member welcome - step navigation", () => {
  it("should skip to where-to-work step for member with no connectors", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    // Member with no defaultAgentSkills goes straight to step 4 (where-to-work)
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });
  });

  it("should show Slack and web options in where-to-work step", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    // Member lands directly on step 4
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /Add .+ to Slack/ }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: /Continue in web/ }),
    ).toBeInTheDocument();
  });
});
