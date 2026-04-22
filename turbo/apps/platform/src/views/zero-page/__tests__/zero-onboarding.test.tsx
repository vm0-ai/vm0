import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { onboardingStatusContract } from "@vm0/core";

const context = testContext();

function mockOnboardingNeeded() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      });
    }),
  );
}

function renderOnboardingPage() {
  detachedSetupPage({ context, path: "/" });
}

describe("zero onboarding - step 1: workspace name", () => {
  it("should render workspace name step when onboarding is needed", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-workspace-name"),
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

  it("should advance to connector selection when Next is clicked", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByText("Next")).toBeInTheDocument();
    });

    // Fill in workspace name so Next is enabled
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");

    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero onboarding - step 2: choose tools", () => {
  it("should show connector selection with search", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Step 1 -> fill name -> Next
    await waitFor(() => {
      expect(screen.getByText("Next")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    click(screen.getByText("Next"));

    // Should reach step 2 (choose tools) — search input is the structural anchor
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors..."),
      ).toBeInTheDocument();
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
        screen.queryByTestId("onboarding-step-workspace-name"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Member Welcome (non-admin onboarding)
// ---------------------------------------------------------------------------

function mockMemberOnboardingNeeded() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: null,
      });
    }),
  );
}

describe("member welcome - step navigation", () => {
  it("should land on step 2 (choose tools) for member on entry", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    // Unified flow: members skip step 1 and start on step 2 (#9129)
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
  });

  it("should skip to where-to-work when member advances with no connectors", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // With no connector selected, Next jumps over step 3 to step 4
    click(screen.getByText("Next"));

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
        screen.getByTestId("onboarding-step-workspace-name"),
      ).toBeInTheDocument();
    });

    // With no connectors selected, step 3 is hidden — 3 visible segments
    expect(screen.getAllByTestId("progress-step")).toHaveLength(3);

    // Reach step 2 and select a connector so step 3 is added back
    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("connector-card-github"));

    await waitFor(() => {
      expect(screen.getAllByTestId("progress-step")).toHaveLength(4);
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-069: Workspace name input accepts text
// ---------------------------------------------------------------------------

describe("workspace name input accepts text (AGENT-D-069)", () => {
  it("workspace name input updates with typed text", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme Corp");
    expect(input).toHaveValue("Acme Corp");
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-057: Step-specific content renders
// ---------------------------------------------------------------------------

describe("step-specific content renders (AGENT-D-057)", () => {
  it("renders connector step content after navigating to step 2", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("Find connectors..."),
      ).toBeInTheDocument();
    });
  });

  it("renders connect step content after navigating to step 3", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // Select a connector so step 3 becomes reachable (#9129: step 3 is
    // conditional on having at least one selected connector)
    click(screen.getByTestId("connector-card-github"));
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-058: Connector selection display renders
// ---------------------------------------------------------------------------

describe("connector selection display renders (AGENT-D-058)", () => {
  it("displays available connectors as selectable items in step 2", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

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
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // Click GitHub connector to select it
    click(screen.getByTestId("connector-card-github"));

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
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // First click: select
    click(screen.getByTestId("connector-card-github"));
    await waitFor(() => {
      expect(screen.getByTestId("connector-check-icon")).toBeInTheDocument();
    });

    // Second click: deselect — check icon should no longer be present
    click(screen.getByTestId("connector-card-github"));
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

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Find connectors...");
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
// AGENT-D-066: Connect button in step 3
// ---------------------------------------------------------------------------

async function navigateToStep3() {
  const input = await screen.findByPlaceholderText("e.g. Acme Corp");
  await fill(input, "Acme");
  click(screen.getByText("Next"));

  await waitFor(() => {
    expect(
      screen.getByTestId("onboarding-step-select-connectors"),
    ).toBeInTheDocument();
  });

  // Select GitHub connector
  click(screen.getByTestId("connector-card-github"));

  // Advance to step 3
  click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
  });
}

describe("connect button is present in step 3 (AGENT-D-066)", () => {
  it("connect button is rendered for selected connectors in step 3", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await navigateToStep3();

    expect(screen.getByText("Connect")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-059: Connector polling status shows
// ---------------------------------------------------------------------------

describe("connector polling status shows (AGENT-D-059)", () => {
  it("skips step 3 entirely when step 2 is advanced without selections", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // With no connector selected, Next from step 2 jumps straight to step 4
    // (#9129 — step 3 is conditional on having at least one connector).
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-where-to-work"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("onboarding-step-connect"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-068: Back button returns to previous step
// ---------------------------------------------------------------------------

describe("back button returns to previous step (AGENT-D-068)", () => {
  it("back button returns to step 1 from step 2", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Navigate to step 2
    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    // Click Back
    click(screen.getByText("Back"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-workspace-name"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-061: Slack/Web integration setup cards render
// ---------------------------------------------------------------------------

describe("slack/web integration setup cards render (AGENT-D-061)", () => {
  it("slack and web cards are displayed in step 4 for member", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    // Member starts at step 2 under the unified flow; advance to step 4
    // by clicking Next without selecting a connector.
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByText(/Add .+ to Slack/)).toBeInTheDocument();
      expect(screen.getByText(/Continue in web/)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Skip step 2 when connectors arrive via ?connector= deep link
// ---------------------------------------------------------------------------

describe("connectors via URL skip step 2", () => {
  it("admin: skips step 2 when connectors arrive via URL", async () => {
    mockOnboardingNeeded();
    detachedSetupPage({ context, path: "/onboarding?connector=slack" });

    // Admin step 1 should show (workspace name)
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-workspace-name"),
      ).toBeInTheDocument();
    });

    // Fill step 1 and advance — should skip step 2 and land on step 3
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });

    // Step 2 (choose tools) should NOT be shown
    expect(
      screen.queryByTestId("onboarding-step-select-connectors"),
    ).not.toBeInTheDocument();
  });

  it("member: lands directly on step 3 when connectors arrive via URL", async () => {
    mockMemberOnboardingNeeded();
    detachedSetupPage({ context, path: "/onboarding?connector=github" });

    // Member should skip step 2 and land on step 3 (connect)
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });
  });

  it("admin: back from step 3 returns to step 1 when connectors via URL", async () => {
    mockOnboardingNeeded();
    detachedSetupPage({ context, path: "/onboarding?connector=slack" });

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    // On step 3
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-connect")).toBeInTheDocument();
    });

    click(screen.getByText("Back"));

    // Should go back to step 1 (skipping step 2)
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-workspace-name"),
      ).toBeInTheDocument();
    });
  });

  it("falls back to normal flow when no valid URL connectors", async () => {
    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding?connector=unknown_only",
    });

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    // Should land on step 2 (choose tools) — normal flow
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
  });
});
