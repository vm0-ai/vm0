import {
  onboardingSetupContract,
  onboardingStatusContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockOnboardingNeeded(): void {
  context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
  context.mocks.api(onboardingSetupContract.setup, ({ respond }) => {
    return respond(200, {
      agentId: "d0000000-0000-4000-a000-000000000001",
    });
  });
}

async function completeWorkspaceStep(): Promise<void> {
  await fill(await screen.findByPlaceholderText("e.g. Acme Corp"), "Acme");
  click(screen.getByTestId("onboarding-role-founder"));
  await waitFor(() => {
    expect(screen.getByTestId("onboarding-next-button")).not.toBeDisabled();
  });
  click(screen.getByTestId("onboarding-next-button"));
}

describe("zero onboarding", () => {
  it("lets an admin create a workspace, choose connectors, and reach trial", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-workspace-name"),
      ).toBeInTheDocument();
    });

    await completeWorkspaceStep();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("Find connectors..."),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors..."), "GitHub");
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-github")).toBeInTheDocument();
      expect(
        screen.queryByTestId("connector-card-slack"),
      ).not.toBeInTheDocument();
    });
    click(screen.getByTestId("connector-card-github"));
    await waitFor(() => {
      expect(screen.getByTestId("connector-check-icon")).toBeInTheDocument();
    });

    click(screen.getByTestId("onboarding-next-button"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-trial")).toBeInTheDocument();
      expect(screen.getByText(/Get Started/)).toBeInTheDocument();
      expect(
        screen.getByText("Workflows that run themselves"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Show Website preview"));
    await waitFor(() => {
      expect(
        screen.getByText("Websites that look hand-designed"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Landing pages, brand sites, launch microsites"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Show Illustration preview"));
    await waitFor(() => {
      expect(
        screen.getByText("Illustrations in your brand voice"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Editorial covers, hero art, mascots"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Show Workflow preview"));
    await waitFor(() => {
      expect(
        screen.getByText("Workflows that run themselves"),
      ).toBeInTheDocument();
    });
  });

  it("shows an empty connector search result while choosing tools", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({ context, path: "/" });

    await completeWorkspaceStep();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-select-connectors"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors..."), "not-a-tool");

    await waitFor(() => {
      expect(
        screen.getByText("No connectors match your search."),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("connector-card-github"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps pending invitations visible while onboarding", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/onboarding",
      org: {
        activeOrg: { id: "org_current", name: "Current Org" },
        memberships: [
          {
            id: "org_current",
            organization: { id: "org_current", name: "Current Org" },
          },
        ],
        pendingInvitations: [
          {
            id: "inv_pending",
            publicOrganizationData: {
              id: "org_invited",
              name: "Invited Org",
              imageUrl: "",
            },
            accept: () => {
              return Promise.resolve({});
            },
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Invited Org")).toBeInTheDocument();
      expect(screen.getByText("Join")).toBeInTheDocument();
    });
  });
});
