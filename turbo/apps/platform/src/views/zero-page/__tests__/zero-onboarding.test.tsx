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
        hasModelProvider: false,
        hasDefaultAgent: false,
        defaultAgentName: null,
        defaultAgentComposeId: null,
        defaultAgentMetadata: null,
        defaultAgentSkills: [],
      });
    }),
  );
}

async function renderOnboardingPage() {
  await setupPage({ context, path: "/" });
}

describe("zero onboarding - step 1: welcome", () => {
  it("should render welcome dialog when onboarding is needed", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Step 1 shows the welcome dialog with typewriter text
    await waitFor(
      () => {
        expect(
          screen.getByText(/Meet Zero, your new teammate/),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it("should show Next button in step 1", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: "Next" }),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it("should advance to connector step when Next is clicked", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: "Next" }),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Add connector")).toBeInTheDocument();
    });
  });
});

describe("zero onboarding - step 3: connectors", () => {
  it("should show connector step with skip instruction", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Step 1 -> Next
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: "Next" }),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // Should reach step 3 (connectors)
    await waitFor(() => {
      expect(screen.getByText("Add connector")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/You can skip and add more later/),
    ).toBeInTheDocument();
  });
});

describe("zero onboarding - does not render when not needed", () => {
  it("should not show onboarding dialog when needsOnboarding is false", async () => {
    // Default mock handler already returns needsOnboarding: false
    await renderOnboardingPage();

    // Wait for page to load and verify onboarding dialog is NOT shown
    await waitFor(() => {
      // The chat page tagline should be visible instead
      expect(
        screen.queryByText(/Meet Zero, your new teammate/),
      ).not.toBeInTheDocument();
    });
  });
});
