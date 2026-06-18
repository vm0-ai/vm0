import {
  onboardingSetupContract,
  onboardingStatusContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

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
  it("keeps admins in app onboarding when the paid redirect switch is disabled", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/?prompt=hello%20world&connector=github&vm0_source=presentation",
      featureSwitches: { [FeatureSwitchKey.PaidOnboardingRedirect]: false },
    });

    await waitFor(() => {
      expect(pathname()).toBe("/onboarding");
      const params = new URLSearchParams(search());
      expect(params.get("prompt")).toBe("hello world");
      expect(params.get("connector")).toBe("github");
      expect(params.get("vm0_source")).toBeNull();
    });
  });

  it("redirects admins who need onboarding to paid onboarding with query params", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/?prompt=hello%20world&connector=github&vm0_source=presentation",
      featureSwitches: { [FeatureSwitchKey.PaidOnboardingRedirect]: true },
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://so.vm7.ai:8443");
      expect(url.pathname).toBe("/onboarding/2afcf6");
      expect(url.searchParams.get("prompt")).toBe("hello world");
      expect(url.searchParams.get("connector")).toBe("github");
      expect(url.searchParams.get("vm0_source")).toBe("presentation");
      expect(url.searchParams.get("domain")).toBe("api.vm7.ai:8443");
    });
  });

  it("redirects direct onboarding visits to paid onboarding when enabled", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello%20world&connector=github&vm0_source=presentation",
      featureSwitches: { [FeatureSwitchKey.PaidOnboardingRedirect]: true },
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://so.vm7.ai:8443");
      expect(url.pathname).toBe("/onboarding/2afcf6");
      expect(url.searchParams.get("prompt")).toBe("hello world");
      expect(url.searchParams.get("connector")).toBe("github");
      expect(url.searchParams.get("vm0_source")).toBe("presentation");
      expect(url.searchParams.get("domain")).toBe("api.vm7.ai:8443");
    });
  });

  it("redirects direct paid onboarding without loading connectors first", async () => {
    mockOnboardingNeeded();
    context.mocks.api(zeroConnectorsMainContract.list, ({ respond }) => {
      return respond(500, {
        error: {
          message: "Failed to load connectors",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello%20world&connector=github&vm0_source=presentation",
      featureSwitches: { [FeatureSwitchKey.PaidOnboardingRedirect]: true },
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://so.vm7.ai:8443");
      expect(url.pathname).toBe("/onboarding/2afcf6");
      expect(url.searchParams.get("prompt")).toBe("hello world");
      expect(url.searchParams.get("connector")).toBe("github");
      expect(url.searchParams.get("vm0_source")).toBe("presentation");
      expect(url.searchParams.get("domain")).toBe("api.vm7.ai:8443");
    });
  });

  it("lets an admin create a workspace, choose connectors, and reach trial", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/onboarding",
      featureSwitches: { [FeatureSwitchKey.PaidOnboardingRedirect]: false },
    });

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

    detachedSetupPage({
      context,
      path: "/onboarding",
      featureSwitches: { [FeatureSwitchKey.PaidOnboardingRedirect]: false },
    });

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
      featureSwitches: { [FeatureSwitchKey.PaidOnboardingRedirect]: false },
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
