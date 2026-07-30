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
import { zeroStrapiIntegrationsContract } from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

afterEach(async () => {
  document.documentElement.lang = DEFAULT_LOCALE;
  await initializeI18n(DEFAULT_LOCALE);
});

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
  options: {
    teamsEnabled?: boolean;
    feishuEnabled?: boolean;
    strapiEnabled?: boolean;
  } = {},
): void {
  detachedSetupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.TeamsIntegration]: options.teamsEnabled ?? false,
      [FeatureSwitchKey.FeishuIntegration]: options.feishuEnabled ?? false,
      [FeatureSwitchKey.StrapiIntegration]: options.strapiEnabled ?? false,
    },
  });
}

describe("works page", () => {
  it("shows skeleton rows while Feishu settings load", async () => {
    const responseReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroFeishuConnectContract.getStatus,
      async ({ respond }) => {
        await responseReady.promise;
        return respond(200, {
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
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/settings/feishu",
      featureSwitches: {
        [FeatureSwitchKey.FeishuIntegration]: true,
      },
    });

    await expect(
      screen.findByTestId("feishu-settings-loading"),
    ).resolves.toBeInTheDocument();

    responseReady.resolve();
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
    expect(screen.queryByTestId("feishu-settings-loading")).toBeNull();
  });

  it("shows Feishu setup troubleshooting guidance", async () => {
    mockFeishuAPI();

    detachedSetupPage({
      context,
      path: "/settings/feishu",
      featureSwitches: {
        [FeatureSwitchKey.FeishuIntegration]: true,
      },
    });

    await expect(
      screen.findByRole("heading", { name: "Setup FAQ" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        /Why does Feishu show "Challenge code didn't get a response"\?/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Return to the Tokens step/)).toBeInTheDocument();
    expect(
      screen.getByText("Why is publishing the app waiting for approval?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Feishu sends the approval request/),
    ).toBeInTheDocument();
  });

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
      expect(screen.queryByText("Strapi")).not.toBeInTheDocument();
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
    expect(queryRole("button", "Add bot")).toBeNull();
    click(getRole("button", "More options for Okou Feishu"));
    expect(queryRole("button", "Manage")).toBeNull();
    expect(getRole("button", "Uninstall")).toBeInTheDocument();
  });

  it("shows Strapi only when its integration switch is enabled", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    setupWorksPage({ strapiEnabled: true });

    await waitFor(() => {
      expect(screen.getByText("Strapi")).toBeInTheDocument();
      expect(
        screen.getByText("Automate work when entries are published"),
      ).toBeInTheDocument();
    });
  });

  it("redirects direct Strapi settings navigation when the switch is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/settings/strapi",
      featureSwitches: {
        [FeatureSwitchKey.StrapiIntegration]: false,
      },
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(screen.queryByText("Add Strapi instance")).not.toBeInTheDocument();
  });

  it("checks whether Strapi delivered its external test webhook", async () => {
    const integrationId = "00000000-0000-4000-8000-000000000091";
    let tested = false;
    context.mocks.api(zeroStrapiIntegrationsContract.list, ({ respond }) => {
      return respond(200, [
        {
          id: integrationId,
          name: "Marketing CMS",
          baseUrl: "https://cms.example.com",
          webhookUrl: `https://www.vm0.test/api/zero/strapi/events/${integrationId}`,
          secretLastFour: "abcd",
          lastTestedAt: tested ? "2026-07-28T04:00:00.000Z" : null,
          lastReceivedAt: null,
          createdAt: "2026-07-28T03:00:00.000Z",
        },
      ]);
    });
    context.mocks.api(
      zeroStrapiIntegrationsContract.checkTest,
      ({ respond }) => {
        tested = true;
        return respond(200, {
          received: true,
          lastTestedAt: "2026-07-28T04:00:00.000Z",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/settings/strapi",
      featureSwitches: {
        [FeatureSwitchKey.StrapiIntegration]: true,
      },
    });

    await expect(
      screen.findByText("Marketing CMS"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Webhook tested")).not.toBeInTheDocument();
    click(getRole("button", "Check test"));
    await expect(
      screen.findByText("Webhook tested"),
    ).resolves.toBeInTheDocument();
  });

  it("localizes Strapi settings in Portuguese while preserving integration data", async () => {
    const integrationId = "00000000-0000-4000-8000-000000000092";
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    context.mocks.api(zeroStrapiIntegrationsContract.list, ({ respond }) => {
      return respond(200, [
        {
          id: integrationId,
          name: "Marketing CMS",
          baseUrl: "https://cms.example.com",
          webhookUrl: `https://www.vm0.test/api/zero/strapi/events/${integrationId}`,
          secretLastFour: "abcd",
          lastTestedAt: "2026-07-28T04:00:00.000Z",
          lastReceivedAt: null,
          createdAt: "2026-07-28T03:00:00.000Z",
        },
      ]);
    });
    context.mocks.api(
      zeroStrapiIntegrationsContract.checkTest,
      ({ respond }) => {
        return respond(200, {
          received: true,
          lastTestedAt: "2026-07-28T04:00:00.000Z",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/settings/strapi",
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
        [FeatureSwitchKey.StrapiIntegration]: true,
      },
    });

    await expect(
      screen.findByText("Marketing CMS"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "Permita que o Zero reaja a entradas publicadas no Strapi e automatize o trabalho subsequente.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Webhook testado")).toBeInTheDocument();
    expect(getRole("button", "Verificar teste")).toBeInTheDocument();
    expect(screen.getByText(/^Último teste:/u)).toBeInTheDocument();
    expect(screen.getByText("https://cms.example.com")).toBeInTheDocument();
    click(getRole("button", "Verificar teste"));
    await expect(
      screen.findByText("Webhook de teste do Strapi recebido"),
    ).resolves.toBeInTheDocument();
    expect(document.documentElement.lang).toBe("pt-BR");
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

  it("hides Feishu management actions from organization members", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({
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
          isConnected: false,
          appId: "cli_member",
          callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
          callbackVerified: true,
          messageReceived: true,
          tenantKey: "tenant-member",
          tenantName: "Member bot",
          defaultAgentId: agentId,
          defaultAgentName: "Okou",
          setupCompleted: false,
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
    expect(queryRole("button", "Add bot")).toBeNull();
    expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
    expect(queryRole("link", "Connect")).toBeNull();

    expect(queryRole("button", "More options for Member bot")).toBeNull();
  });

  it("lets an organization admin use the completed review guide", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      installationId,
      appId: "cli_completed_admin",
      callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-admin",
      tenantName: "Completed admin bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          id: installationId,
          isConnected: true,
          appId: "cli_completed_admin",
          callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
          callbackVerified: true,
          messageReceived: true,
          tenantKey: "tenant-admin",
          tenantName: "Completed admin bot",
          defaultAgentId: agentId,
          defaultAgentName: "Okou",
          setupCompleted: true,
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();
    expect(queryRole("button", "Add bot")).toBeNull();

    click(getRole("button", "More options for Completed admin bot"));
    expect(queryRole("button", "Manage")).toBeNull();
    expect(getRole("button", "Uninstall")).toBeInTheDocument();
    expect(getRole("button", "Disconnect")).toBeInTheDocument();
    click(getRole("button", "Review guide"));

    expect(
      screen.getByRole("heading", { name: "Feishu review guide" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Create an enterprise custom app"),
    ).toBeInTheDocument();

    click(getRole("button", "Next"));
    expect(screen.getByLabelText("App ID")).toHaveValue("cli_completed_admin");
    expect(screen.getByLabelText("App ID")).toBeDisabled();
    expect(screen.getByLabelText("App Secret")).toBeDisabled();
    expect(screen.getByLabelText("App Secret")).toHaveAttribute(
      "placeholder",
      "Configured",
    );

    click(getRole("button", "Next"));
    expect(screen.getByLabelText("Encrypt Key")).toBeDisabled();
    expect(screen.getByLabelText("Verification Token")).toBeDisabled();
    expect(getRole("button", "Next")).toBeEnabled();

    click(getRole("button", "Next"));
    expect(screen.getByText("Configure event delivery")).toBeInTheDocument();

    click(getRole("button", "Next"));
    expect(
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();

    click(getRole("button", "Next"));
    expect(screen.getByText("Publish the app")).toBeInTheDocument();
    expect(screen.getByLabelText("Default agent")).toBeDisabled();

    click(getRole("button", "Done"));
    expect(
      screen.queryByRole("heading", { name: "Feishu review guide" }),
    ).toBeNull();
  });

  it("only lets a connected non-admin disconnect their own account", async () => {
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
        },
      ],
    });

    setupWorksPage({ feishuEnabled: true });
    click(await screen.findByTestId("feishu-setup-button"));
    await expect(screen.findByText("Feishu bots")).resolves.toBeInTheDocument();

    click(getRole("button", "More options for Member bot"));
    expect(getRole("button", "Disconnect")).toBeInTheDocument();
    expect(queryRole("button", "Review guide")).toBeNull();
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
    expect(open).toHaveBeenCalledWith(
      `${connectUrl}&callbackTarget=app`,
      "_blank",
    );
    expect(queryRole("button", "More options for Member bot")).toBeNull();
  });

  it("refreshes Feishu setup status after an Ably update", async () => {
    const installationId = "00000000-0000-4000-8000-000000000001";
    const agentId = "00000000-0000-4000-8000-000000000002";
    let callbackVerified = false;
    let isConnected = false;
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    context.mocks.api(zeroFeishuConnectContract.getStatus, ({ respond }) => {
      const installation = {
        id: installationId,
        isConnected,
        appId: "cli_feishu",
        callbackUrl: `https://api.vm0.test/api/zero/feishu/events/${installationId}`,
        oauthRedirectUrl: "https://app.vm0.test/connectors/feishu/callback",
        callbackVerified,
        messageReceived: false,
        tenantKey: null,
        tenantName: null,
        defaultAgentId: agentId,
        defaultAgentName: "Okou",
      };
      return respond(200, {
        isConnected,
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
      screen.getByRole("img", {
        name: "Feishu Event Configuration screen with the subscription mode edit control highlighted",
      }),
    ).toBeInTheDocument();
    click(getRole("button", "Show next Feishu guide image"));
    expect(
      screen.getByRole("img", {
        name: "Feishu Event Configuration screen with the Request URL field highlighted",
      }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText("Waiting for callback")).not.toHaveLength(0);
      expect(document.body).toHaveTextContent("im.message.receive_v1");
      expect(context.mocks.ably.hasSubscription("feishu:changed")).toBeTruthy();
    });

    callbackVerified = true;
    isConnected = true;
    context.mocks.ably.trigger("feishu:changed");

    await waitFor(() => {
      expect(screen.getByText("Callback verified")).toBeInTheDocument();
      expect(getRole("button", "Next")).toBeEnabled();
      expect(
        screen.getByText("Feishu connected successfully"),
      ).toBeInTheDocument();
    });

    click(getRole("button", "Next"));
    expect(
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "https://app.vm0.test/connectors/feishu/callback",
      ),
    ).toBeInTheDocument();
  });

  it("shows the guided Feishu custom app setup for organization admins", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockFeishuAPI({ isAdmin: true });
    setupWorksPage({ feishuEnabled: true });

    click(await screen.findByTestId("feishu-setup-button"));

    click(await screen.findByText("Add bot"));

    await expect(
      screen.findByText("Create an enterprise custom app"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu app creation form with the app name, icon, and Create button highlighted",
      }),
    ).toBeInTheDocument();
    expect(queryRole("button", "Show creating a Feishu app guide")).toBeNull();
    expect(
      screen.getByText("Download the VM0 icon").closest("a"),
    ).toHaveAttribute("download", "vm0-feishu-app-icon.png");

    click(screen.getByText("Next"));

    await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu app creation result showing where to find the App ID and App Secret",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Verification Token"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Default agent")).not.toBeInTheDocument();
  });

  it("rejects a registered Feishu App ID on the credentials step", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockFeishuAPI({ isAdmin: true });
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
