import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import {
  teamsConnectContract,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import {
  FEISHU_OAUTH_SCOPES,
  feishuConnectContract,
  type FeishuConnectStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  holdElementAnimations,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_PHONE_HANDLE = "+15555550123";

function queryRole(
  role: "button" | "link",
  name: string,
  container?: HTMLElement,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name
      );
    }) ?? null
  );
}

function getRole(
  role: "button" | "link",
  name: string,
  container?: HTMLElement,
): HTMLElement {
  const element = queryRole(role, name, container);
  if (!element) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return element;
}

function getIntegrationCard(title: string): HTMLElement {
  const card = screen.getByText(title).closest(".zero-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Expected integration card titled "${title}"`);
  }
  return card;
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
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
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
    connectUrl: "/api/teams/oauth/connect?orgId=org_1&userId=user_1",
  };
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
}

function mockFeishuAPI(overrides: Partial<FeishuConnectStatus> = {}): void {
  const defaults: FeishuConnectStatus = {
    publicBrand: "vm0",
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
  context.mocks.api(feishuConnectContract.getStatus, ({ respond }) => {
    return respond(200, { ...defaults, ...overrides });
  });
  context.mocks.api(feishuConnectContract.checkAppId, ({ respond }) => {
    return respond(200, { available: true });
  });
}

function setupWorksPage(
  options: {
    feishuEnabled?: boolean;
  } = {},
): void {
  detachedSetupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.FeishuIntegration]: options.feishuEnabled ?? false,
    },
  });
}

async function openAgentPhoneConnectDialog(): Promise<HTMLElement> {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  setupWorksPage();

  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("agentphone:changed"),
    ).toBeTruthy();
  });
  click(await screen.findByLabelText("Connect phone"));

  const dialog = await screen.findByRole("dialog", {
    name: "Connect phone",
  });
  return dialog;
}

function publishAgentPhoneLinked(): void {
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: AGENT_PHONE_HANDLE,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.ably.trigger("agentphone:changed");
}

async function disconnectAndReopenAgentPhone(): Promise<HTMLElement> {
  click(await screen.findByLabelText("Phone options"));
  click(await screen.findByLabelText("Disconnect"));
  click(await screen.findByLabelText("Connect phone"));
  return screen.findByRole("dialog", { name: "Connect phone" });
}

describe("works page", () => {
  it("shows skeleton rows while Feishu settings load", async () => {
    const responseReady = context.mocks.deferred<void>();
    context.mocks.api(feishuConnectContract.getStatus, async ({ respond }) => {
      await responseReady.promise;
      return respond(200, {
        publicBrand: "vm0",
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
    });

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
    const githubConnectUrl =
      "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id";
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
        connectUrl: githubConnectUrl,
      }),
    );
    context.mocks.data.agentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    const browserOpen = context.mocks.browser.open(authWindow);

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Microsoft Teams")).toBeInTheDocument();
      expect(screen.queryByText("Feishu")).not.toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("Telegram")).toBeInTheDocument();
      expect(screen.getByText("Phone")).toBeInTheDocument();
      expect(screen.getByText(/update permissions/i)).toBeInTheDocument();
      expect(screen.getByText("Connected (VM0 HQ)")).toBeInTheDocument();
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("+15555551212");
      expect(screen.getByTestId("github-connect-button")).toBeInTheDocument();
      expect(context.mocks.ably.hasSubscription("github:changed")).toBeTruthy();
    });

    click(screen.getByTestId("github-connect-button"));
    await waitFor(() => {
      const openedUrl = new URL(authWindow.location.href);
      expect(openedUrl.origin + openedUrl.pathname).toBe(
        "https://github.com/login/oauth/authorize",
      );
      expect(openedUrl.searchParams.get("client_id")).toBe(
        "github-oauth-client-id",
      );
      expect(openedUrl.searchParams.has("_t")).toBeTruthy();
    });
    expect(browserOpen.calls).toStrictEqual([
      {
        url: "about:blank",
        target: "_blank",
        features: "width=600,height=700",
      },
    ]);

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
        screen.getByTestId("github-connected-indicator"),
      ).toHaveTextContent("Connected (@octocat)");
    });
  });

  it("guides an unlinked AgentPhone user to message the shared number", async () => {
    const dialog = await openAgentPhoneConnectDialog();

    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByText("Send “hi” to this number")).toBeVisible();
    expect(within(dialog).getByText("hi")).toBeVisible();
    expect(getRole("button", "Copy +1 (903) 985-3128", dialog)).toBeVisible();
    expect(getRole("link", "Open Messages", dialog)).toHaveAttribute(
      "href",
      "sms:+19039853128",
    );
    expect(
      within(dialog).getByText(
        "We’ll reply with a connection link. Open it within 10 minutes to finish connecting.",
      ),
    ).toBeVisible();
  });

  it("closes AgentPhone instructions when the phone is linked", async () => {
    const dialog = await openAgentPhoneConnectDialog();
    const finishCloseAnimation = holdElementAnimations(dialog);

    publishAgentPhoneLinked();

    await expect(
      screen.findByTestId("agentphone-connected-indicator"),
    ).resolves.toHaveTextContent(AGENT_PHONE_HANDLE);
    expect(dialog).toBeInTheDocument();
    expect(dialog).toBeVisible();

    finishCloseAnimation();

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Connect phone" }),
      ).not.toBeInTheDocument();
    });

    const reopenedDialog = await disconnectAndReopenAgentPhone();
    expect(within(reopenedDialog).queryByRole("textbox")).toBeNull();
    expect(getRole("link", "Open Messages", reopenedDialog)).toBeVisible();
  });

  it("opens Telegram settings from the integrations list", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    setupWorksPage();

    click(await screen.findByLabelText("Open Telegram settings"));

    await waitFor(() => {
      expect(screen.getByText("Back to integrations")).toBeInTheDocument();
    });
  });

  it("shows Microsoft Teams status", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      tenantName: "VM0 Tenant",
      teamName: "Core Team",
    });

    setupWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Microsoft Teams")).toBeInTheDocument();
      expect(screen.getByText("Connected (Core Team)")).toBeInTheDocument();
      expect(screen.getByTestId("github-integration-card")).toBeInTheDocument();
    });

    const slackCard = getIntegrationCard("Slack");
    const teamsCard = getIntegrationCard("Microsoft Teams");
    const githubCard = getIntegrationCard("GitHub");
    expect(
      slackCard.compareDocumentPosition(teamsCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      teamsCard.compareDocumentPosition(githubCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(githubCard).getByTestId("github-install-button"),
    ).toHaveAttribute(
      "href",
      "https://github.com/apps/vm0-test/installations/new?state=abc",
    );
  });

  it("asks workspace members to contact an admin before installing GitHub", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    context.mocks.api(
      integrationsGithubContract.getInstallation,
      ({ respond }) => {
        return respond(404, {
          error: {
            message: "GitHub installation not found",
            code: "NOT_FOUND",
          },
          installUrl: null,
        });
      },
    );

    setupWorksPage();

    const githubCard = await screen.findByTestId("github-integration-card");
    expect(
      within(githubCard).getByText(
        "Ask an organization admin to install the GitHub App",
      ),
    ).toBeInTheDocument();
    expect(
      within(githubCard).queryByTestId("github-install-button"),
    ).toBeNull();
    expect(
      within(githubCard).queryByTestId("github-connect-button"),
    ).toBeNull();
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
        "https://api.vm0.test/api/okou/feishu/events/00000000-0000-4000-8000-000000000001",
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-feishu",
      tenantName: "VM0 Feishu",
      defaultAgentId: "00000000-0000-4000-8000-000000000002",
      defaultAgentName: "Okou",
      installations: [
        {
          publicBrand: "vm0",
          id: "00000000-0000-4000-8000-000000000001",
          isConnected: true,
          connectedUserName: "Feishu User",
          appId: "cli_feishu",
          botName: "Okou Feishu",
          botAvatarUrl: "https://example.com/okou-feishu.png",
          callbackUrl:
            "https://api.vm0.test/api/okou/feishu/events/00000000-0000-4000-8000-000000000001",
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
      callbackUrl: `https://api.vm0.test/api/okou/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-member",
      tenantName: "Member bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          publicBrand: "vm0",
          id: installationId,
          isConnected: false,
          appId: "cli_member",
          callbackUrl: `https://api.vm0.test/api/okou/feishu/events/${installationId}`,
          connectUrl:
            "https://www.vm0.test/api/feishu/oauth/connect?state=incomplete",
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
    expect(queryRole("button", "Connect")).toBeNull();

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
      callbackUrl: `https://api.vm0.test/api/okou/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-admin",
      tenantName: "Completed admin bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          publicBrand: "vm0",
          id: installationId,
          isConnected: true,
          appId: "cli_completed_admin",
          callbackUrl: `https://api.vm0.test/api/okou/feishu/events/${installationId}`,
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
    expect(
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();

    click(getRole("button", "Next"));
    expect(screen.getByText("Import user token scopes")).toBeInTheDocument();
    expect(screen.getByText("Scopes")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu Permissions & Scopes page with the Batch import/export scopes menu highlighted",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu Batch import/export scopes dialog with the imported JSON and review button highlighted",
      }),
    ).toBeInTheDocument();
    expect(queryRole("button", "Show next Feishu guide image")).toBeNull();
    expect(screen.getByText("User token scope JSON")).toBeInTheDocument();
    const scopeImportJson = screen.getByTestId("feishu-user-scope-import-json");
    expect(JSON.parse(scopeImportJson.textContent ?? "")).toStrictEqual({
      scopes: {
        tenant: [],
        user: [...FEISHU_OAUTH_SCOPES],
      },
    });
    expect(screen.getByRole("note")).toBeInTheDocument();

    click(getRole("button", "Next"));
    expect(screen.getByText("Configure event delivery")).toBeInTheDocument();

    click(getRole("button", "Next"));
    expect(screen.getByText("Publish the app")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu Version Management page with the Create a version button highlighted",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu version details page with the availability settings edit action highlighted",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu availability settings with All members selected",
      }),
    ).toBeInTheDocument();
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
      callbackUrl: `https://api.vm0.test/api/okou/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: "tenant-member",
      tenantName: "Member bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          publicBrand: "vm0",
          id: installationId,
          isConnected: true,
          appId: "cli_member",
          callbackUrl: `https://api.vm0.test/api/okou/feishu/events/${installationId}`,
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
      "https://www.vm0.test/api/feishu/oauth/connect?state=member";
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    mockFeishuAPI({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      installationId,
      appId: "cli_member_connect",
      callbackUrl: `https://www.vm0.test/api/okou/feishu/events/${installationId}`,
      callbackVerified: true,
      messageReceived: false,
      tenantKey: "tenant-member",
      tenantName: "Member bot",
      defaultAgentId: agentId,
      defaultAgentName: "Okou",
      installations: [
        {
          publicBrand: "vm0",
          id: installationId,
          isConnected: false,
          appId: "cli_member_connect",
          callbackUrl: `https://www.vm0.test/api/okou/feishu/events/${installationId}`,
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
    context.mocks.api(feishuConnectContract.getStatus, ({ respond }) => {
      const installation = {
        id: installationId,
        publicBrand: "vm0" as const,
        isConnected,
        appId: "cli_feishu",
        callbackUrl: `https://api.vm0.test/api/okou/feishu/events/${installationId}`,
        oauthRedirectUrl: "https://app.vm0.test/connectors/feishu/callback",
        callbackVerified,
        messageReceived: false,
        tenantKey: null,
        tenantName: null,
        defaultAgentId: agentId,
        defaultAgentName: "Okou",
      };
      return respond(200, {
        publicBrand: "vm0",
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
      screen.getByText("Configure the OAuth redirect URL"),
    ).toBeInTheDocument();
    const redirectGuideImage = screen.getByRole("img", {
      name: "Feishu Security Settings page showing where to add an OAuth redirect URL",
    });
    const redirectUrlInput = screen.getByDisplayValue(
      "https://app.vm0.test/connectors/feishu/callback",
    );
    expect(
      redirectGuideImage.compareDocumentPosition(redirectUrlInput) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    click(getRole("button", "Next"));
    expect(screen.getByText("Import user token scopes")).toBeInTheDocument();
    click(getRole("button", "Next"));
    expect(
      screen.getByRole("img", {
        name: "Feishu Event Configuration screen with the subscription mode edit control highlighted",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Feishu Event Configuration screen with the Request URL field highlighted",
      }),
    ).toBeInTheDocument();
    expect(queryRole("button", "Show next Feishu guide image")).toBeNull();

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
    expect(screen.getByText("Publish the app")).toBeInTheDocument();
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
    const createGuideImage = screen.getByRole("img", {
      name: "Feishu app creation form with the app name, icon, and Create button highlighted",
    });
    expect(createGuideImage).toHaveAttribute("width", "1234");
    expect(createGuideImage).toHaveAttribute("height", "998");
    expect(queryRole("button", "Show creating a Feishu app guide")).toBeNull();
    const iconDownloadLink = screen
      .getByText("Download the optional VM0 icon")
      .closest("a");
    expect(iconDownloadLink).toHaveAttribute(
      "href",
      "https://static.vm0.io/platform/views/zero-page/assets/feishu/app-icon-okou-fefdc683bf5c.png",
    );
    expect(iconDownloadLink).toHaveAttribute(
      "download",
      "vm0-feishu-app-icon.png",
    );
    expect(
      screen.getByRole("img", { name: "Optional VM0 app icon" }),
    ).toHaveAttribute(
      "src",
      "https://static.vm0.io/platform/views/zero-page/assets/feishu/app-icon-okou-fefdc683bf5c.png",
    );

    click(screen.getByText("Next"));

    await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toBeInTheDocument();
    const credentialsGuideImage = screen.getByRole("img", {
      name: "Feishu app creation result showing where to find the App ID and App Secret",
    });
    expect(credentialsGuideImage).toHaveAttribute("width", "1190");
    expect(credentialsGuideImage).toHaveAttribute("height", "1076");
    expect(
      screen.queryByLabelText("Verification Token"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Default agent")).not.toBeInTheDocument();
  });

  it("rejects a registered Feishu App ID on the credentials step", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockFeishuAPI({ isAdmin: true });
    context.mocks.api(
      feishuConnectContract.checkAppId,
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

    setupWorksPage();

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

    setupWorksPage();

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
    expect(url.pathname).toBe("/api/teams/oauth/connect");
    expect(url.searchParams.get("orgId")).toBe("org_1");
    expect(url.searchParams.get("userId")).toBe("user_1");
  });

  it("shows Microsoft Teams connect controls after installation", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({ isConnected: false, isInstalled: true, isAdmin: true });

    setupWorksPage();

    const connectButton = await screen.findByTestId("teams-connect-button");
    expect(connectButton).toHaveTextContent("Connect");
    expect(
      screen.queryByTestId("teams-install-button"),
    ).not.toBeInTheDocument();
  });

  it("shows Microsoft Teams admin uninstall confirmation", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    mockTeamsAPI({ isConnected: false, isInstalled: true, isAdmin: true });

    setupWorksPage();

    click(await screen.findByLabelText("More Microsoft Teams options"));
    click(await screen.findByLabelText("Uninstall Microsoft Teams"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Microsoft Teams integration?"),
      ).toBeInTheDocument();
    });
  });
});
