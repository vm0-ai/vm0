import {
  zeroIntegrationsSlackContract,
  type SlackOrgStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import {
  zeroTeamsConnectContract,
  type TeamsConnectStatus,
} from "@vm0/api-contracts/contracts/zero-teams-connect";
import {
  zeroFeishuConnectContract,
  type FeishuConnectStatus,
} from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

function mockTeamsAPI(overrides: Partial<TeamsConnectStatus> = {}): void {
  const defaults: TeamsConnectStatus = {
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    installUrl:
      "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
    connectUrl: "/api/zero/teams/oauth/connect?orgId=org_1&vm0UserId=user_1",
  };
  context.mocks.api(zeroTeamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
}

function mockFeishuAPI(overrides: Partial<FeishuConnectStatus> = {}): void {
  const defaults: FeishuConnectStatus = {
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    installUrl: "https://applink.feishu.cn/client/bot",
    tenantKey: null,
    tenantName: null,
    defaultAgentName: "Okou",
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
  context.mocks.api(zeroFeishuConnectContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
}

function setupWorksPage(
  options: { teamsEnabled?: boolean; feishuEnabled?: boolean } = {},
): void {
  detachedSetupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.TeamsIntegration]: options.teamsEnabled ?? false,
      [FeatureSwitchKey.FeishuIntegration]: options.feishuEnabled ?? false,
    },
  });
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
    context.mocks.data.agentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.queryByText("Microsoft Teams")).not.toBeInTheDocument();
      expect(screen.queryByText("Feishu")).not.toBeInTheDocument();
      expect(screen.getByText("Telegram")).toBeInTheDocument();
      expect(screen.getByText("Phone")).toBeInTheDocument();
      expect(screen.getByText(/update permissions/i)).toBeInTheDocument();
      expect(screen.getByText("Connected (VM0 HQ)")).toBeInTheDocument();
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("+15555551212");
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

  it("shows Microsoft Teams status when the Teams integration is enabled", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      tenantName: "VM0 Tenant",
      teamName: "Core Team",
    });

    setupWorksPage({ teamsEnabled: true });

    await waitFor(() => {
      expect(screen.getByText("Microsoft Teams")).toBeInTheDocument();
      expect(screen.getByText("Connected (Core Team)")).toBeInTheDocument();
    });
  });

  it("shows Feishu only when its integration switch is enabled", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockFeishuAPI({
      isConnected: true,
      isInstalled: true,
      tenantKey: "tenant-feishu",
    });

    setupWorksPage({ feishuEnabled: true });

    await waitFor(() => {
      expect(screen.getByText("Feishu")).toBeInTheDocument();
      expect(
        screen.getByTestId("feishu-connected-indicator"),
      ).toHaveTextContent("Connected");
    });
  });

  it("does not show the Microsoft Teams tenant id when names are unavailable", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      tenantId: "tenant-123",
      tenantName: null,
      teamName: null,
    });

    setupWorksPage({ teamsEnabled: true });

    await waitFor(() => {
      expect(screen.getByText("Microsoft Teams")).toBeInTheDocument();
      expect(screen.getByText("Connected")).toBeInTheDocument();
      expect(
        screen.queryByText("Connected (tenant-123)"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows Microsoft Teams admin install controls before installation", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({ isConnected: false, isInstalled: false, isAdmin: true });

    setupWorksPage({ teamsEnabled: true });

    const installButton = await screen.findByTestId("teams-install-button");
    expect(installButton).toHaveTextContent("Install in Teams");
    expect(
      screen.getByText(
        "Connect your Microsoft account, then install the Teams app",
      ),
    ).toBeInTheDocument();
    click(installButton);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [openedUrl, target] = openSpy.mock.calls[0] ?? [];
    expect(typeof openedUrl).toBe("string");
    expect(target).toBe("_blank");
    const url = new URL(String(openedUrl), window.location.origin);
    expect(url.pathname).toBe("/api/zero/teams/oauth/connect");
    expect(url.searchParams.get("orgId")).toBe("org_1");
    expect(url.searchParams.get("vm0UserId")).toBe("user_1");
  });

  it("shows Microsoft Teams connect controls after installation", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({ isConnected: false, isInstalled: true, isAdmin: true });

    setupWorksPage({ teamsEnabled: true });

    const connectButton = await screen.findByTestId("teams-connect-button");
    expect(connectButton).toHaveTextContent("Connect");
    expect(
      screen.queryByTestId("teams-install-button"),
    ).not.toBeInTheDocument();
  });

  it("shows Microsoft Teams admin uninstall confirmation", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({ isConnected: false, isInstalled: true, isAdmin: true });

    setupWorksPage({ teamsEnabled: true });

    click(await screen.findByLabelText("More Microsoft Teams options"));
    click(await screen.findByLabelText("Uninstall Microsoft Teams"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Microsoft Teams integration?"),
      ).toBeInTheDocument();
    });
  });
});
