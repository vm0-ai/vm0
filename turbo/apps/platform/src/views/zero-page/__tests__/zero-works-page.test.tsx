import {
  zeroIntegrationsSlackContract,
  type SlackOrgStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockSlackAPI(overrides: Partial<SlackOrgStatus> = {}): void {
  const defaults: SlackOrgStatus = {
    isConnected: false,
    isInstalled: false,
    isAdmin: false,
    installUrl: null,
    connectUrl: null,
    reinstallUrl: null,
    scopeMismatch: false,
    workspaceName: null,
    agentOrgSlug: null,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
  context.mocks.api(zeroIntegrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
}

function setupWorksPage(): void {
  detachedSetupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
  });
}

function getGithubCard(): HTMLElement {
  const card = screen.getByText("GitHub").closest(".zero-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error("GitHub card not found");
  }
  return card;
}

describe("works page", () => {
  it("shows integration cards with current connection status and realtime refreshes", async () => {
    mockSlackAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      scopeMismatch: true,
      reinstallUrl: "https://slack.com/oauth/reinstall?state=xyz",
      workspaceName: "VM0 HQ",
    });
    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration({
        isConnected: false,
        connectedGithubUserId: null,
        connectedGithubUsername: null,
        connectUrl:
          "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id",
      }),
    );
    context.mocks.data.agentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Telegram")).toBeInTheDocument();
      expect(screen.getByText("Phone")).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText(/update permissions/i)).toBeInTheDocument();
      expect(screen.getByText("Connected (VM0 HQ)")).toBeInTheDocument();
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("+15555551212");
      expect(within(getGithubCard()).getByText("Connect")).toBeInTheDocument();
      expect(context.mocks.ably.hasSubscription("github:changed")).toBeTruthy();
    });

    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration({
        isConnected: true,
        connectedGithubUserId: "98765",
        connectedGithubUsername: "octocat",
      }),
    );
    context.mocks.ably.trigger("github:changed");

    await waitFor(() => {
      expect(
        within(getGithubCard()).getByText("Connected (@octocat)"),
      ).toBeInTheDocument();
    });
  });

  it("opens Telegram settings from the integrations list", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    setupWorksPage();

    click(await screen.findByLabelText("Open Telegram settings"));

    await waitFor(() => {
      expect(screen.getByText("Back to integrations")).toBeInTheDocument();
    });
  });
});
