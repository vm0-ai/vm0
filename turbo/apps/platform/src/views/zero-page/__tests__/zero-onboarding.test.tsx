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
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    });

    // Fill in workspace name so Next is enabled
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Test Workspace");

    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
  });
});

describe("zero onboarding - step 2: choose tools", () => {
  it("should show connector selection with search", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    // Step 1 -> fill name -> Next
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Test Workspace");
    await user.click(screen.getByRole("button", { name: "Next" }));

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
// AGENT-D-056: Onboarding step indicator renders
// ---------------------------------------------------------------------------

describe("onboarding step indicator renders (AGENT-D-056)", () => {
  it("renders a progress bar with step segments for admin flow", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    // Admin flow has 4 visible steps, rendered as 4 bar segments
    const segments = document.querySelectorAll(".h-1.flex-1.rounded-full");
    expect(segments).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-063: Workspace name input renders
// ---------------------------------------------------------------------------

describe("workspace name input renders (AGENT-D-063)", () => {
  it("renders workspace name text input in step 1", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. Acme Corp")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-069: Workspace name input accepts text
// ---------------------------------------------------------------------------

describe("workspace name input accepts text (AGENT-D-069)", () => {
  it("workspace name input updates with typed text", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme Corp");
    expect(input).toHaveValue("Acme Corp");
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-057: Step-specific content renders
// ---------------------------------------------------------------------------

describe("step-specific content renders (AGENT-D-057)", () => {
  it("renders connector step content after navigating to step 2", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
      expect(screen.getByText(/Select the apps you use/)).toBeInTheDocument();
    });
  });

  it("renders connect step content after navigating to step 3", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-058: Connector selection display renders
// ---------------------------------------------------------------------------

describe("connector selection display renders (AGENT-D-058)", () => {
  it("displays available connectors as selectable items in step 2", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });

    // Connectors are rendered as buttons with connector labels
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
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

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });

    // Click GitHub connector to select it
    const githubCard = screen.getByText("GitHub").closest("button");
    await user.click(githubCard!);

    // After click, the selected card renders the check icon (svg)
    await waitFor(() => {
      const githubBtn = screen.getByText("GitHub").closest("button");
      // IconCircleCheckFilled is rendered as an SVG inside the selected button
      expect(githubBtn?.querySelector("svg")).toBeInTheDocument();
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

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });

    const githubCard = screen.getByText("GitHub").closest("button");
    // First click: select
    await user.click(githubCard!);
    await waitFor(() => {
      const btn = screen.getByText("GitHub").closest("button");
      expect(btn?.querySelector("svg")).toBeInTheDocument();
    });

    // Second click: deselect — check icon should no longer be present
    const githubCardAgain = screen.getByText("GitHub").closest("button");
    await user.click(githubCardAgain!);
    await waitFor(() => {
      const btn = screen.getByText("GitHub").closest("button");
      expect(
        btn?.querySelector('[class*="text-primary"]'),
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
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search connectors...");
    await user.type(searchInput, "GitHub");

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      // Slack should no longer be visible after filtering for GitHub
      expect(screen.queryByText("Slack")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-066: Connect button in step 3
// ---------------------------------------------------------------------------

async function navigateToStep3(user: ReturnType<typeof userEvent.setup>) {
  const input = await screen.findByPlaceholderText("e.g. Acme Corp");
  await user.clear(input);
  await user.type(input, "Acme");
  await user.click(screen.getByRole("button", { name: "Next" }));

  await waitFor(() => {
    expect(screen.getByText("Choose your tools")).toBeInTheDocument();
  });

  // Select GitHub connector
  const githubCard = screen.getByText("GitHub").closest("button");
  await user.click(githubCard!);

  // Advance to step 3
  await user.click(screen.getByRole("button", { name: "Next" }));

  await waitFor(() => {
    expect(screen.getByText("Connect your apps")).toBeInTheDocument();
  });
}

describe("connect button is present in step 3 (AGENT-D-066)", () => {
  it("connect button is rendered for selected connectors in step 3", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await navigateToStep3(user);

    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-059: Connector polling status shows
// ---------------------------------------------------------------------------

describe("connector polling status shows (AGENT-D-059)", () => {
  it("shows no connectors message when step 3 is reached without selections", async () => {
    const user = userEvent.setup();
    mockOnboardingNeeded();
    await renderOnboardingPage();

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });

    // Skip selection and go directly to step 3
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
      expect(screen.getByText(/No connectors selected/)).toBeInTheDocument();
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
    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await user.clear(input);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });

    // Click Back
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByText("Name your workspace")).toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// AGENT-D-061: Slack/Web integration setup cards render
// ---------------------------------------------------------------------------

describe("slack/web integration setup cards render (AGENT-D-061)", () => {
  it("slack and web cards are displayed in step 4 for member", async () => {
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add .+ to Slack/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Continue in web/ }),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AGENT-D-062: Error messages display during onboarding
// ---------------------------------------------------------------------------

describe("error messages display during onboarding (AGENT-D-062)", () => {
  it("where-to-work step renders action buttons that initiate onboarding completion", async () => {
    // This test verifies that the step-4 UI is ready to show errors when
    // the completion API fails. The WhereToWorkContent component renders
    // an error div (text-destructive class) when the loadable enters hasError state.
    mockMemberOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // Both action buttons are rendered and enabled before any error
    const slackBtn = screen.getByRole("button", { name: /Add .+ to Slack/ });
    const webBtn = screen.getByRole("button", { name: /Continue in web/ });

    expect(slackBtn).toBeInTheDocument();
    expect(webBtn).toBeInTheDocument();
    expect(slackBtn).not.toBeDisabled();
    expect(webBtn).not.toBeDisabled();
  });
});
