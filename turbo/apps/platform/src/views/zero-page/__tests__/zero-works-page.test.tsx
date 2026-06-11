import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroIntegrationsSlackContract,
  type SlackOrgStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
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

function createGithubConnector(): ConnectorResponse {
  return {
    id: "d0000000-0000-4000-a000-000000000001",
    type: "github",
    authMethod: "oauth",
    externalId: "98765",
    externalUsername: "testuser",
    externalEmail: "test@example.com",
    oauthScopes: ["repo", "project", "workflow"],
    connectionStatus: "connected",
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
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

  it("starts Slack and GitHub connection entry points from the cards", async () => {
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    const openMock = context.mocks.browser.open(authWindow);
    mockSlackAPI({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.com/oauth/install?state=abc",
    });
    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration({
        isConnected: false,
        connectedGithubUserId: null,
        connectUrl:
          "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id",
      }),
    );
    context.mocks.data.connectors([createGithubConnector()]);

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByTestId("slack-install-button")).toBeInTheDocument();
    });
    click(screen.getByTestId("slack-install-button"));
    expect(openMock.calls[0]?.url).toContain("slack.com/oauth/install");

    authWindow.location.href = "";
    await waitFor(() => {
      expect(within(getGithubCard()).getByText("Connect")).toBeInTheDocument();
    });
    click(within(getGithubCard()).getByText("Connect"));

    await waitFor(() => {
      expect(authWindow.location.href).toContain(
        "github.com/login/oauth/authorize",
      );
    });
  });

  it("refreshes Slack status from realtime events", async () => {
    let slackStatus: SlackOrgStatus = {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.com/oauth/install?state=abc",
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
    context.mocks.api(
      zeroIntegrationsSlackContract.getStatus,
      ({ respond }) => {
        return respond(200, slackStatus);
      },
    );

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByTestId("slack-install-button")).toBeInTheDocument();
      expect(context.mocks.ably.hasSubscription("slack:changed")).toBeTruthy();
    });

    slackStatus = {
      ...slackStatus,
      isInstalled: true,
      connectUrl: "https://slack.com/oauth/connect?state=def",
      workspaceName: "VM0 HQ",
    };
    context.mocks.ably.trigger("slack:changed");

    await waitFor(() => {
      expect(
        screen.getByText("Slack installed successfully"),
      ).toBeInTheDocument();
    });

    slackStatus = {
      ...slackStatus,
      isConnected: true,
      connectUrl: null,
    };
    context.mocks.ably.trigger("slack:changed");

    await waitFor(() => {
      expect(
        screen.getByText("Slack connected successfully"),
      ).toBeInTheDocument();
      expect(screen.getByText("Connected (VM0 HQ)")).toBeInTheDocument();
    });

    slackStatus = {
      ...slackStatus,
      isConnected: false,
      connectUrl: "https://slack.com/oauth/connect?state=ghi",
    };
    context.mocks.ably.trigger("slack:changed");

    await waitFor(() => {
      expect(screen.getByText("Disconnected from Slack")).toBeInTheDocument();
    });

    slackStatus = {
      ...slackStatus,
      isInstalled: false,
      connectUrl: null,
      workspaceName: null,
    };
    context.mocks.ably.trigger("slack:changed");

    await waitFor(() => {
      expect(
        screen.getByText("Slack workspace uninstalled"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("slack-install-button")).toBeInTheDocument();
    });
  });

  it("manages Slack disconnect, uninstall, and permission-update actions", async () => {
    const disconnectDeferred = context.mocks.deferred<void>();
    const openMock = context.mocks.browser.open();
    mockSlackAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      scopeMismatch: true,
      reinstallUrl: "https://slack.com/oauth/reinstall?state=xyz",
    });
    context.mocks.api(
      zeroIntegrationsSlackContract.disconnect,
      ({ respond }) => {
        return disconnectDeferred.promise.then(() => {
          return respond(200, { ok: true });
        });
      },
    );

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByText(/update permissions/i)).toBeInTheDocument();
    });
    click(screen.getByText(/update permissions/i));
    expect(openMock.calls[0]?.url).toContain("slack.com/oauth/reinstall");

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByText("Disconnecting…")).toBeInTheDocument();
    });
    disconnectDeferred.resolve();
    await waitFor(() => {
      expect(screen.queryByText("Disconnecting…")).not.toBeInTheDocument();
    });
  });

  it("confirms and uninstalls the Slack workspace integration", async () => {
    const uninstallDeferred = context.mocks.deferred<void>();
    let slackStatus: SlackOrgStatus = {
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      installUrl: "https://slack.com/oauth/install?state=abc",
      connectUrl: null,
      reinstallUrl: null,
      scopeMismatch: false,
      workspaceName: "VM0 HQ",
      agentOrgSlug: null,
      environment: {
        requiredSecrets: [],
        requiredVars: [],
        missingSecrets: [],
        missingVars: [],
      },
    };
    let uninstallRequested = false;
    context.mocks.api(
      zeroIntegrationsSlackContract.getStatus,
      ({ respond }) => {
        return respond(200, slackStatus);
      },
    );
    context.mocks.api(
      zeroIntegrationsSlackContract.disconnect,
      ({ query, respond }) => {
        return uninstallDeferred.promise.then(() => {
          uninstallRequested = query.action === "uninstall";
          if (uninstallRequested) {
            slackStatus = {
              ...slackStatus,
              isConnected: false,
              isInstalled: false,
              workspaceName: null,
            };
          }
          return respond(200, { ok: true });
        });
      },
    );

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connected (VM0 HQ)")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByLabelText("Uninstall"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Slack integration?"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/This will remove the Slack integration/u),
    ).toBeInTheDocument();

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByText("Uninstall Slack integration?"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByLabelText("Uninstall"));
    const dialog = await screen.findByRole("dialog");
    click(within(dialog).getByText("Uninstall"));

    await waitFor(() => {
      expect(screen.getByText("Uninstalling…")).toBeInTheDocument();
    });
    uninstallDeferred.resolve();

    await waitFor(() => {
      expect(uninstallRequested).toBeTruthy();
      expect(
        screen.queryByText("Uninstall Slack integration?"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("slack-install-button")).toBeInTheDocument();
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

  it("verifies, validates, and disconnects the phone integration", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    context.mocks.data.agentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    setupWorksPage();

    click(await screen.findByLabelText("Connect phone"));
    const input = await screen.findByTestId("agentphone-phone-input");
    await fill(input, "555-1212");
    fireEvent.blur(input);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Enter a phone number with country code, like +1 555 555 1212.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Send verification")).toBeDisabled();
    });

    await fill(input, "+1 (555) 555-1212");
    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-normalized-phone"),
      ).toHaveTextContent("+15555551212");
    });
    click(screen.getByText("Send verification"));

    await waitFor(() => {
      expect(
        screen.getByText(/Verification text sent to \+15555551212/i),
      ).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("agentphone:changed"),
      ).toBeTruthy();
    });

    context.mocks.data.agentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    context.mocks.ably.trigger("agentphone:changed");

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("+15555551212");
    });

    click(screen.getByLabelText("Phone options"));
    click(await screen.findByLabelText("Disconnect phone"));

    await waitFor(() => {
      expect(screen.getByLabelText("Connect phone")).toBeInTheDocument();
    });
  });
});
