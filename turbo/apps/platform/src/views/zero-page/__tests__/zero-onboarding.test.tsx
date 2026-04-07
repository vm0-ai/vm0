import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("zero onboarding - step 1: choose tools", () => {
  it("should render connector selection step when onboarding is needed", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
  });

  it("should show Next button in step 1", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByText("Next")).toBeInTheDocument();
    });
  });

  it("should advance to connect step when Next is clicked", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByText("Next")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });
  });
});

describe("zero onboarding - step 2: connect apps", () => {
  it("should show connect step with search and connector cards", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Step 1: select a connector
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("connector-card-github"));
    await user.click(screen.getByText("Next"));

    // Should reach step 2 (connect apps)
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });
  });
});

describe("zero onboarding - does not render when not needed", () => {
  it("should not show onboarding dialog when needsOnboarding is false", async () => {
    // Default mock handler already returns needsOnboarding: false
    await renderOnboardingPage();

    // Wait for page to load and verify onboarding is NOT shown
    await waitFor(() => {
      expect(
        screen.queryByTestId("onboarding-step-select-connectors"),
      ).not.toBeInTheDocument();
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
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
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

    // Member with no defaultAgentSkills goes straight to step 3 (where-to-work)
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-where-to-work"),
      ).toBeInTheDocument();
    });
  });

  it("should show Slack and web options in where-to-work step", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    // Member lands directly on step 3
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-where-to-work"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/Add .+ to Slack/)).toBeInTheDocument();

    expect(screen.getByText(/Continue in web/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-056: Onboarding step indicator renders
// ---------------------------------------------------------------------------

describe("onboarding step indicator renders (AGENT-D-056)", () => {
  it("renders a progress bar with step segments for admin flow", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // Admin flow has 3 visible steps, rendered as 3 bar segments
    const segments = screen.getAllByTestId("progress-step");
    expect(segments).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-057: Step-specific content renders
// ---------------------------------------------------------------------------

describe("step-specific content renders (AGENT-D-057)", () => {
  it("renders connector step content as step 1", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("Search connectors..."),
      ).toBeInTheDocument();
    });
  });

  it("renders connect step content after navigating to step 2", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-058: Connector selection display renders
// ---------------------------------------------------------------------------

describe("connector selection display renders (AGENT-D-058)", () => {
  it("displays available connectors as selectable items in step 1", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // Connectors are rendered as selectable cards
    expect(screen.getByTestId("connector-card-github")).toBeInTheDocument();
    expect(screen.getByTestId("connector-card-slack")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-060: Selected connectors display renders
// ---------------------------------------------------------------------------

describe("selected connectors display renders (AGENT-D-060)", () => {
  it("selected connector shows check icon", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // Click GitHub connector to select it
    await user.click(screen.getByTestId("connector-card-github"));

    // After click, the selected card renders the check icon
    await waitFor(() => {
      expect(screen.getByTestId("connector-check-icon")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-064: Connector selection buttons toggle
// ---------------------------------------------------------------------------

describe("connector selection buttons toggle (AGENT-D-064)", () => {
  it("clicking connector twice deselects it", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // First click: select
    await user.click(screen.getByTestId("connector-card-github"));
    await waitFor(() => {
      expect(screen.getByTestId("connector-check-icon")).toBeInTheDocument();
    });

    // Second click: deselect — check icon should no longer be present
    await user.click(screen.getByTestId("connector-card-github"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("connector-check-icon"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-065: Connector search input filters list
// ---------------------------------------------------------------------------

describe("connector search input filters list (AGENT-D-065)", () => {
  it("search filters connector list to matching items", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search connectors...");
    await user.type(searchInput, "GitHub");

    await waitFor(() => {
      expect(screen.getByTestId("connector-card-github")).toBeInTheDocument();
      // Slack should no longer be visible after filtering for GitHub
      expect(
        screen.queryByTestId("connector-card-slack"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-066: Connect button in step 2
// ---------------------------------------------------------------------------

async function navigateToStep2(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(
      screen.getByTestId("onboarding-step-select-connectors"),
    ).toBeInTheDocument();
  });

  // Select GitHub connector
  await user.click(screen.getByTestId("connector-card-github"));

  // Advance to step 2
  await user.click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
  });
}

describe("connect button is present in step 2 (AGENT-D-066)", () => {
  it("connect button is rendered for selected connectors in step 2", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await navigateToStep2(user);

    expect(screen.getByText("Connect")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-059: Connector polling status shows
// ---------------------------------------------------------------------------

describe("connector polling status shows (AGENT-D-059)", () => {
  it("shows no connectors message when step 2 is reached without selections", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // Skip selection and go directly to step 2
    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
      expect(
        screen.getByTestId("onboarding-no-connectors"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-068: Back button returns to previous step
// ---------------------------------------------------------------------------

describe("back button returns to previous step (AGENT-D-068)", () => {
  it("back button returns to step 1 from step 2", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Navigate to step 2
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });

    // Click Back
    await user.click(screen.getByText("Back"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-061: Slack/Web integration setup cards render
// ---------------------------------------------------------------------------

describe("slack/web integration setup cards render (AGENT-D-061)", () => {
  it("slack and web cards are displayed in step 3 for member", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByText(/Add .+ to Slack/)).toBeInTheDocument();
      expect(screen.getByText(/Continue in web/)).toBeInTheDocument();
    });
  });
});
