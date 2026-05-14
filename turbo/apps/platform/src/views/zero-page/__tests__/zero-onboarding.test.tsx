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
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  onboardingSetupContract,
  onboardingStatusContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { pathname$ } from "../../../signals/route.ts";

const context = testContext();
const mockApi = createMockApi(context);

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
    // Step 1 Next eagerly provisions the workspace — every test that walks
    // past step 1 needs this mock available.
    mockApi(onboardingSetupContract.setup, ({ respond }) => {
      return respond(200, {
        agentId: "d0000000-0000-4000-a000-000000000001",
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

describe("onboarding guard entry routes", () => {
  it.each([
    "/telegram/connect?bot=bot-123",
    "/settings/slack?w=ws1&u=user1",
    "/connectors/gmail/connect",
    "/connectors/gmail/authorize?agentId=00000000-0000-0000-0000-000000000001",
    "/activities/inspect",
    "/schedules/00000000-0000-0000-0000-000000000001",
    "/redeem/ZERO100",
  ])("redirects %s to onboarding when onboarding is required", async (path) => {
    mockOnboardingNeeded();

    detachedSetupPage({ context, path, withoutRender: true });

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/onboarding");
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

  it("step 2 is the terminal step — its primary button continues into web", async () => {
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

    await waitFor(() => {
      expect(screen.getByText(/Get Started/)).toBeInTheDocument();
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
// AGENT-D-056: Onboarding step indicator renders
// ---------------------------------------------------------------------------

describe("onboarding step indicator renders (AGENT-D-056)", () => {
  it("renders a two-segment progress bar for the admin flow", async () => {
    mockOnboardingNeeded();
    await renderOnboardingPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-workspace-name"),
      ).toBeInTheDocument();
    });

    // The regular admin flow has exactly two steps: name workspace + pick tools.
    expect(screen.getAllByTestId("progress-step")).toHaveLength(2);

    // Selecting a connector on step 2 doesn't add steps — step 2 is terminal.
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
      expect(screen.getByTestId("connector-check-icon")).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("progress-step")).toHaveLength(2);
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
// AGENT-D-068: Back button hidden after eager init
// ---------------------------------------------------------------------------

describe("back button hidden after eager init (AGENT-D-068)", () => {
  it("step 1 Next eagerly provisions the workspace; no Back button on step 2", async () => {
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

    // The workspace + default agent have already been created — going back
    // to rename the workspace would be misleading, so Back is hidden.
    expect(screen.queryByText("Back")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ?connector= deep link pre-selects connectors on step 2
// ---------------------------------------------------------------------------

describe("connectors via URL pre-select on step 2", () => {
  it("admin: ?connector= pre-selects the connector on step 2", async () => {
    mockOnboardingNeeded();
    detachedSetupPage({ context, path: "/onboarding?connector=slack" });

    // Admin step 1 should show (workspace name)
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-workspace-name"),
      ).toBeInTheDocument();
    });

    // Fill step 1 and advance — lands on step 2 with slack pre-selected.
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("connector-check-icon")).toBeInTheDocument();
  });

  it("falls back to an empty selection when no valid URL connectors", async () => {
    mockOnboardingNeeded();
    detachedSetupPage({
      context,
      path: "/onboarding?connector=unknown_only",
    });

    const input = await screen.findByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Acme");
    click(screen.getByText("Next"));

    // Should land on step 2 (choose tools) — normal flow, nothing pre-selected
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("connector-check-icon"),
    ).not.toBeInTheDocument();
  });
});
