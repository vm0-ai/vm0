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

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function queryRole(role: "button" | "link", name: string): HTMLElement | null {
  return (
    queryAllByRoleFast(role).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name
      );
    }) ?? null
  );
}

function getRole(role: "button" | "link", name: string): HTMLElement {
  const element = queryRole(role, name);
  if (!element) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return element;
}

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
    appId: null,
    callbackUrl: null,
    callbackVerified: false,
    messageReceived: false,
    tenantKey: null,
    tenantName: null,
    defaultAgentId: null,
    defaultAgentName: "Okou",
  };
  context.mocks.api(zeroFeishuConnectContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
  context.mocks.api(zeroFeishuConnectContract.checkAppId, ({ respond }) => {
    return respond(200, { available: true });
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
      connectedUserName: "Feishu User",
      isInstalled: true,
      appId: "cli_feishu",
      installationId: "00000000-0000-4000-8000-000000000001",
      callbackUrl:
        "https://api.vm0.test/api/zero/feishu/events/00000000-0000-4000-8000-000000000001",
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-feishu",
      tenantName: "VM0 Feishu",
      defaultAgentId: "00000000-0000-4000-8000-000000000002",
      defaultAgentName: "Okou",
      installations: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          isConnected: true,
          connectedUserName: "Feishu User",
          appId: "cli_feishu",
          botName: "Okou Feishu",
          botAvatarUrl: "https://example.com/okou-feishu.png",
          callbackUrl:
            "https://api.vm0.test/api/zero/feishu/events/00000000-0000-4000-8000-000000000001",
          callbackVerified: true,
          messageReceived: true,
          tenantKey: "tenant-feishu",
          tenantName: "VM0 Feishu",
          defaultAgentId: "00000000-0000-4000-8000-000000000002",
          defaultAgentName: "Okou",
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });

    await waitFor(() => {
      expect(screen.getByText("Feishu")).toBeInTheDocument();
      expect(
        screen.getByText("Route Feishu messages to agents"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("feishu-setup-button"));

    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
    expect(screen.getByText("Okou Feishu")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Okou Feishu bot icon" }),
    ).toHaveAttribute("src", "https://example.com/okou-feishu.png");
    expect(screen.getByText("Connected (Feishu User)")).toBeInTheDocument();
    click(getRole("button", "More options for Okou Feishu"));
    expect(queryRole("button", "Manage")).toBeNull();
    expect(getRole("button", "Uninstall")).toBeInTheDocument();
  });

  it("redirects direct Feishu settings navigation when the switch is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/settings/feishu",
      featureSwitches: {
        [FeatureSwitchKey.FeishuIntegration]: false,
      },
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(screen.queryByText("Feishu bots")).not.toBeInTheDocument();
  });

  it("shows Feishu management actions to a bot owner", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({
      isInstalled: true,
      isAdmin: false,
      installationId,
      appId: "cli_owner",
      callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-owner",
      tenantName: "Owner bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          id: installationId,
          isConnected: false,
          appId: "cli_owner",
          callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
          connectUrl: `https://api.vm0.test/api/zero/feishu/oauth/connect?state=owner`,
          callbackVerified: true,
          messageReceived: true,
          tenantKey: "tenant-owner",
          tenantName: "Owner bot",
          defaultAgentId: agentId,
          defaultAgentName: "Okou",
          canManage: true,
          setupCompleted: false,
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
    expect(getRole("button", "Add bot")).toBeInTheDocument();
    expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
    expect(queryRole("link", "Connect")).toBeNull();

    click(getRole("button", "More options for Owner bot"));
    expect(getRole("button", "Manage")).toBeInTheDocument();
    click(getRole("button", "Uninstall"));
    expect(
      screen.getByRole("heading", { name: "Uninstall Feishu bot?" }),
    ).toBeInTheDocument();
  });

  it("keeps the Feishu setup guide available after setup completes", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({
      isInstalled: true,
      isAdmin: false,
      installationId,
      appId: "cli_completed_owner",
      callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-owner",
      tenantName: "Completed owner bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          id: installationId,
          isConnected: false,
          appId: "cli_completed_owner",
          callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
          callbackVerified: true,
          messageReceived: true,
          tenantKey: "tenant-owner",
          tenantName: "Completed owner bot",
          defaultAgentId: agentId,
          defaultAgentName: "Okou",
          canManage: true,
          setupCompleted: true,
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();

    click(getRole("button", "More options for Completed owner bot"));
    click(getRole("button", "Setup guide"));
    expect(
      screen.getByText("Import the required permissions"),
    ).toBeInTheDocument();
  });

  it("only lets a connected non-owner disconnect their own account", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: false,
      installationId,
      appId: "cli_member",
      callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-member",
      tenantName: "Member bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          id: installationId,
          isConnected: true,
          appId: "cli_member",
          callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
          callbackVerified: true,
          messageReceived: true,
          tenantKey: "tenant-member",
          tenantName: "Member bot",
          defaultAgentId: agentId,
          defaultAgentName: "Okou",
          canManage: false,
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();

    click(getRole("button", "More options for Member bot"));
    expect(getRole("button", "Disconnect")).toBeInTheDocument();
    expect(queryRole("button", "Manage")).toBeNull();
    expect(queryRole("button", "Uninstall")).toBeNull();
  });

  it("lets a workspace member connect a completed Feishu bot", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    const connectUrl =
      "https://www.vm0.test/api/zero/feishu/oauth/connect?state=member";
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      installationId,
      appId: "cli_member_connect",
      callbackUrl: `https://www.vm0.test/api/zero/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: false,
      tenantKey: "tenant-member",
      tenantName: "Member bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          id: installationId,
          isConnected: false,
          appId: "cli_member_connect",
          callbackUrl: `https://www.vm0.test/api/zero/feishu/events/${installationId}`,
          connectUrl,
          callbackVerified: true,
          setupCompleted: true,
          messageReceived: false,
          tenantKey: "tenant-member",
          tenantName: "Member bot",
          defaultAgentId: agentId,
          defaultAgentName: "Okou",
          canManage: false,
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();

    expect(screen.queryByText("Ready")).toBeNull();
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });
    click(getRole("button", "Connect"));
    expect(open).toHaveBeenCalledWith(connectUrl, "_blank");
    expect(queryRole("button", "More options for Member bot")).toBeNull();
  });

  it("refreshes Feishu setup status after an Ably update", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    let callbackVerified = false;
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    context.mocks.api(zeroFeishuConnectContract.getStatus, ({ respond }) => {
      const installation = {
        id: installationId,
        isConnected: false,
        appId: "cli_feishu",
        callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
        oauthRedirectUrl: "https://api.vm0.test/api/zero/feishu/oauth/callback",
        callbackVerified,
        messageReceived: false,
        tenantKey: null,
        tenantName: null,
        defaultAgentId: agentId,
        defaultAgentName: "Okou",
      };
      return respond(200, {
        isConnected: false,
        isInstalled: true,
        isAdmin: true,
        installationId,
        appId: installation.appId,
        callbackUrl: installation.callbackUrl,
        callbackVerified,
        messageReceived: false,
        tenantKey: null,
        tenantName: null,
        defaultAgentId: agentId,
        defaultAgentName: "Okou",
        installations: [installation],
      });
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
    click(getRole("button", "More options for Feishu bot"));
    click(getRole("button", "Manage"));
    expect(
      screen.getByText("Import the required permissions"),
    ).toBeInTheDocument();
    expect(document.body).toHaveTextContent("im:message.p2p_msg:readonly");
    expect(document.body).toHaveTextContent("im:message.group_at_msg:readonly");
    expect(document.body).toHaveTextContent("im:message.group_msg");
    expect(document.body).toHaveTextContent("im:message.reactions:write_only");
    click(getRole("button", "Next"));

    expect(
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "https://api.vm0.test/api/zero/feishu/oauth/callback",
      ),
    ).toBeInTheDocument();
    click(getRole("button", "Next"));

    await waitFor(() => {
      expect(screen.getAllByText("Waiting for callback")).not.toHaveLength(0);
      expect(document.body).toHaveTextContent("im.message.receive_v1");
      expect(context.mocks.ably.hasSubscription("feishu:changed")).toBeTruthy();
    });

    callbackVerified = true;
    context.mocks.ably.trigger("feishu:changed");

    await waitFor(() => {
      expect(screen.getByText("Callback verified")).toBeInTheDocument();
      expect(getRole("button", "Next")).toBeEnabled();
    });
  });

  it("shows the guided Feishu custom app setup for organization members", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({ isAdmin: false });
    setupWorksPage({ feishuEnabled: true });

    click(await screen.findByTestId("feishu-setup-button"));

    click(await screen.findByText("Add bot"));

    await expect(
      screen.findByText("Create an enterprise custom app"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("Download the VM0 icon").closest("a"),
    ).toHaveAttribute("download", "vm0-feishu-app-icon.png");

    click(screen.getByText("Next"));

    await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Verification Token"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Default agent")).not.toBeInTheDocument();
  });

  it("rejects a registered Feishu App ID on the credentials step", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({ isAdmin: false });
    context.mocks.api(
      zeroFeishuConnectContract.checkAppId,
      ({ query, respond }) => {
        expect(query.appId).toBe("cli_registered");
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "This Feishu App ID is already registered in VM0",
          },
        });
      },
    );
    setupWorksPage({ feishuEnabled: true });

    click(await screen.findByTestId("feishu-setup-button"));
    click(await screen.findByText("Add bot"));
    click(await screen.findByText("Next"));
    await fill(await screen.findByLabelText("App ID"), "cli_registered");
    await fill(screen.getByLabelText("App Secret"), "app-secret");
    click(getRole("button", "Next"));

    await expect(
      screen.findByText("This Feishu App ID is already registered in VM0"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();
    expect(screen.queryByLabelText("Verification Token")).toBeNull();
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
