import { createHmac, randomInt, randomUUID } from "node:crypto";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

/*
helper gap:
- INT-01 Slack channel, message, upload, and download-file happy paths still
  need public API setup journeys for externally observable Slack channel/file
  state without diagnostic fixture routes.
- INT-02 Telegram linked-bot, message/upload success, internal callback, and
  cleanup flows still need public API setup helpers for bot installation state.
- INT-03 GitHub installed-app and AgentPhone linked-send happy paths need public
  setup APIs for provider installation and downstream agent state before they
  can be covered without diagnostic fixture routes.
*/

const context = testContext();
const bdd = createBddApi(context);
const integrations = createBddIntegrationApi(context);
const AGENTPHONE_WEBHOOK_SECRET = "agentphone-bdd-secret";
const TELEGRAM_BOT_ID = 99_887_766;
const TELEGRAM_BOT_TOKEN = `${TELEGRAM_BOT_ID}:bdd-token`;
const TELEGRAM_OFFICIAL_WEBHOOK_SECRET = "telegram-official-bdd-secret";

interface SlackEphemeralBody {
  readonly response_type: "ephemeral";
  readonly blocks: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function slackBotOauthResponse(args: {
  readonly accessToken: string;
  readonly botUserId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly authedUserId: string;
  readonly scope: string;
}) {
  return {
    ok: true,
    access_token: args.accessToken,
    bot_user_id: args.botUserId,
    team: { id: args.workspaceId, name: args.workspaceName },
    authed_user: { id: args.authedUserId },
    scope: args.scope,
  };
}

function slackUserOauthResponse(args: {
  readonly workspaceId: string;
  readonly authedUserId: string;
}) {
  return {
    ok: true,
    team: { id: args.workspaceId },
    authed_user: { id: args.authedUserId },
  };
}

function expectSlackEphemeral(
  body: unknown,
): asserts body is SlackEphemeralBody {
  if (
    !isRecord(body) ||
    body.response_type !== "ephemeral" ||
    !Array.isArray(body.blocks)
  ) {
    throw new Error("Expected Slack ephemeral response body");
  }
}

function telegramDomainProbe() {
  return http.head("https://oauth.telegram.org/auth", () => {
    return new HttpResponse(null, {
      status: 200,
      headers: { "content-length": "2001" },
    });
  });
}

function telegramSendMessage() {
  return http.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    () => {
      return HttpResponse.json({
        ok: true,
        result: {
          message_id: 321,
          chat: { id: 12_345 },
        },
      });
    },
  );
}

function agentPhoneVerificationSend(
  status: 200 | 503 = 200,
  onBody?: (body: unknown) => void,
) {
  return http.post(
    "https://api.agentphone.test/v1/messages",
    async ({ request }) => {
      const body: unknown = await request.json();
      onBody?.(body);
      const toNumber =
        isRecord(body) && typeof body.to_number === "string"
          ? body.to_number
          : null;
      return HttpResponse.json(
        {
          id: "msg-bdd-agentphone",
          status: status === 200 ? "sent" : "failed",
          channel: "sms",
          from_number: "+19039853128",
          to_number: toNumber,
        },
        { status },
      );
    },
  );
}

function uniquePhoneHandle() {
  return `+1555${randomInt(1_000_000, 9_999_999)}`;
}

function agentPhoneWebhookHeaders(
  body: string,
  webhookId = "evt-bdd-agentphone",
): {
  readonly "x-webhook-signature": string;
  readonly "x-webhook-timestamp": string;
  readonly "x-webhook-event": string;
  readonly "x-webhook-id": string;
} {
  const timestamp = String(Math.floor(now() / 1000));
  return {
    "x-webhook-signature": `sha256=${createHmac(
      "sha256",
      AGENTPHONE_WEBHOOK_SECRET,
    )
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
    "x-webhook-timestamp": timestamp,
    "x-webhook-event": "agent.message",
    "x-webhook-id": webhookId,
  };
}

function githubConnectSignature(args: {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly timestamp: number;
  readonly githubUsername?: string;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(
      [
        args.installationId,
        args.githubUserId,
        String(args.timestamp),
        args.githubUsername?.trim().replace(/^@+/, "") ?? "",
      ].join(":"),
    )
    .digest("hex");
}

describe("INT-01: Slack integration and Slack app routes", () => {
  it("keeps signed Slack Events API URL verification boundaries visible through APIs", async () => {
    integrations.configureSlackSigningSecret();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "slack-bdd-challenge",
    });

    const missingSignature = await integrations.requestSlackEvent(
      body,
      {},
      [401],
    );
    expect(missingSignature.body).toStrictEqual({
      error: "Missing Slack signature headers",
    });

    const invalidSignature = await integrations.requestSlackEvent(
      body,
      {
        ...integrations.signedSlackIngressHeaders(body),
        "x-slack-signature": "v0=invalid",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });

    const verified = await integrations.requestSlackEvent(
      body,
      integrations.signedSlackIngressHeaders(body),
      [200],
    );
    expect(verified.body).toStrictEqual({
      challenge: "slack-bdd-challenge",
    });
  });

  it("keeps signed Slack command and interactive payload boundaries visible through APIs", async () => {
    integrations.configureSlackSigningSecret();

    const commandBody = (text: string) => {
      return new URLSearchParams({
        team_id: "TBDD",
        channel_id: "CBDD",
        user_id: "UBDD",
        text,
        trigger_id: "trigger-bdd",
      }).toString();
    };

    const helpBody = commandBody("help");
    const help = await integrations.requestSlackCommand(
      helpBody,
      integrations.signedSlackIngressHeaders(helpBody),
      [200],
    );
    expectSlackEphemeral(help.body);
    expect(help.body.blocks.length).toBeGreaterThan(0);

    const connectBody = commandBody("connect");
    const connect = await integrations.requestSlackCommand(
      connectBody,
      integrations.signedSlackIngressHeaders(connectBody),
      [200],
    );
    expectSlackEphemeral(connect.body);
    expect(connect.body.blocks.length).toBeGreaterThan(0);

    const disconnectBody = commandBody("disconnect");
    const disconnect = await integrations.requestSlackCommand(
      disconnectBody,
      integrations.signedSlackIngressHeaders(disconnectBody),
      [200],
    );
    expectSlackEphemeral(disconnect.body);
    expect(disconnect.body.blocks.length).toBeGreaterThan(0);

    const unknownBody = commandBody("unknown");
    const unknown = await integrations.requestSlackCommand(
      unknownBody,
      integrations.signedSlackIngressHeaders(unknownBody),
      [200],
    );
    expectSlackEphemeral(unknown.body);
    expect(unknown.body.blocks.length).toBeGreaterThan(0);

    const emptyActionPayload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "TBDD" },
        user: { id: "UBDD" },
        actions: [],
      }),
    }).toString();
    const emptyActions = await integrations.requestSlackInteractive(
      emptyActionPayload,
      integrations.signedSlackIngressHeaders(emptyActionPayload),
      [200],
    );
    expect(emptyActions.body).toBe("");

    const disconnectActionPayload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "TBDD" },
        user: { id: "UBDD" },
        actions: [{ action_id: "home_disconnect" }],
      }),
    }).toString();
    const homeDisconnect = await integrations.requestSlackInteractive(
      disconnectActionPayload,
      integrations.signedSlackIngressHeaders(disconnectActionPayload),
      [200],
    );
    expect(homeDisconnect.body).toBe("");

    const switchActionPayload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "TBDD" },
        user: { id: "UBDD" },
        trigger_id: "trigger-bdd",
        actions: [{ action_id: "home_switch_agent" }],
      }),
    }).toString();
    const homeSwitch = await integrations.requestSlackInteractive(
      switchActionPayload,
      integrations.signedSlackIngressHeaders(switchActionPayload),
      [200],
    );
    expect(homeSwitch.body).toBe("");

    const missingPayloadBody = "";
    const missingPayload = await integrations.requestSlackInteractive(
      missingPayloadBody,
      integrations.signedSlackIngressHeaders(missingPayloadBody),
      [400],
    );
    expect(missingPayload.body).toStrictEqual({ error: "Missing payload" });

    const invalidPayloadBody = new URLSearchParams({
      payload: "not-json",
    }).toString();
    const invalidPayload = await integrations.requestSlackInteractive(
      invalidPayloadBody,
      integrations.signedSlackIngressHeaders(invalidPayloadBody),
      [400],
    );
    expect(invalidPayload.body).toStrictEqual({ error: "Invalid payload" });
  });

  it("keeps Slack browser-connect redirect boundaries visible through APIs", async () => {
    const admin = integrations.user();

    const unauthenticated = await integrations.requestSlackBrowserConnect(
      null,
      {
        w: "TBDD",
        u: "UBDD",
      },
      [307],
    );
    expect(unauthenticated.headers.get("location") ?? "").toContain(
      "/sign-in?redirect_url=",
    );

    const invalidLink = await integrations.requestSlackBrowserConnect(
      admin,
      {},
      [307],
    );
    expect(invalidLink.headers.get("location") ?? "").toContain(
      "/settings/slack?error=Invalid%20connect%20link.",
    );

    const missingWorkspace = await integrations.requestSlackBrowserConnect(
      admin,
      {
        w: "TBDD",
        u: "UBDD",
      },
      [307],
    );
    expect(missingWorkspace.headers.get("location") ?? "").toContain(
      "Workspace%20not%20found.",
    );
  });

  it("keeps Slack org and user connect status boundaries visible through APIs", async () => {
    const admin = integrations.user();

    const unauthenticatedOrgStatus =
      await integrations.requestSlackIntegrationStatus(null, [401]);
    expect(unauthenticatedOrgStatus.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const orgStatus = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(orgStatus.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      connectUrl: null,
    });

    const unauthenticatedConnectStatus =
      await integrations.requestSlackConnectStatus(null, [401]);
    expect(unauthenticatedConnectStatus.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const connectStatus = await integrations.requestSlackConnectStatus(
      admin,
      [200],
    );
    expect(connectStatus.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
    });

    const missingWorkspace = await integrations.requestSlackConnect(
      admin,
      {
        workspaceId: "TBDD",
        slackUserId: "UBDD",
      },
      [404],
    );
    expect(missingWorkspace.body).toStrictEqual({
      error: {
        message: "Workspace not found. Please install the Slack app first.",
        code: "NOT_FOUND",
      },
    });
  });

  it("keeps unauthenticated, not-installed, non-admin, and provider-config errors visible through APIs", async () => {
    const admin = integrations.user();
    const member = integrations.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });

    const unauthenticatedChannels = await integrations.requestListSlackChannels(
      null,
      [401],
    );
    expect(unauthenticatedChannels.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingChannels = await integrations.requestListSlackChannels(
      admin,
      [404],
    );
    expect(missingChannels.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unauthenticatedMessage = await integrations.requestSendSlackMessage(
      null,
      {
        channel: "C123",
        text: "BDD Slack message",
      },
      [401],
    );
    expect(unauthenticatedMessage.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingMessage = await integrations.requestSendSlackMessage(
      admin,
      {
        channel: "C123",
        text: "BDD Slack message",
      },
      [404],
    );
    expect(missingMessage.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingUploadInit = await integrations.requestSlackUploadInit(
      admin,
      {
        filename: "slack-note.txt",
        length: 12,
      },
      [404],
    );
    expect(missingUploadInit.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingUploadComplete = await integrations.requestSlackUploadComplete(
      admin,
      {
        fileId: "F123",
        channel: "C123",
        title: "slack-note.txt",
      },
      [404],
    );
    expect(missingUploadComplete.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unauthenticatedDownload = await integrations.requestSlackDownloadFile(
      null,
      "F123",
      [401],
    );
    expect(unauthenticatedDownload.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingDownloadFileId = await integrations.requestSlackDownloadFile(
      admin,
      undefined,
      [400],
    );
    expect(missingDownloadFileId.body).toStrictEqual({
      error: {
        message: "file_id query parameter is required",
        code: "BAD_REQUEST",
      },
    });

    const missingDownloadInstallation =
      await integrations.requestSlackDownloadFile(admin, "F123", [404]);
    expect(missingDownloadInstallation.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });

    const nonAdminDisconnect = await integrations.requestSlackDisconnect(
      member,
      "delete",
      [404],
    );
    expect(nonAdminDisconnect.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unauthenticatedDisconnect = await integrations.requestSlackDisconnect(
      null,
      undefined,
      [401],
    );
    expect(unauthenticatedDisconnect.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const nonAdminUninstall = await integrations.requestSlackDisconnect(
      member,
      "uninstall",
      [403],
    );
    expect(nonAdminUninstall.body).toStrictEqual({
      error: {
        message: "Admin access required",
        code: "FORBIDDEN",
      },
    });

    const missingUninstall = await integrations.requestSlackDisconnect(
      admin,
      "uninstall",
      [404],
    );
    expect(missingUninstall.body).toStrictEqual({
      error: {
        message: "No Slack installation found",
        code: "NOT_FOUND",
      },
    });

    const oauthWithoutProviderConfig =
      await integrations.requestSlackOauthInstall({}, [503]);
    expect(oauthWithoutProviderConfig.body).toStrictEqual({
      error: "Slack integration is not configured",
    });

    integrations.configureSlackOauthProvider();
    const slackInstall = await integrations.requestSlackOauthInstall(
      {
        orgId: admin.orgId ?? undefined,
        vm0UserId: admin.userId,
        reinstall: "1",
        prompt: "x".repeat(700),
      },
      [307],
    );
    const installLocation = slackInstall.headers.get("location") ?? "";
    const installUrl = new URL(installLocation);
    expect(installUrl.hostname).toBe("slack.com");
    expect(installUrl.searchParams.get("client_id")).toBe(
      "slack-bdd-client-id",
    );
    expect(installUrl.searchParams.get("state") ?? "").toContain(
      '"reinstall":true',
    );

    const missingConnectParams = await integrations.requestSlackOauthConnect(
      {},
      [400],
    );
    expect(missingConnectParams.body).toStrictEqual({
      error: "Missing orgId or vm0UserId",
    });

    const missingConnectInstall = await integrations.requestSlackOauthConnect(
      { orgId: admin.orgId ?? "org_bdd_slack", vm0UserId: admin.userId },
      [404],
    );
    expect(missingConnectInstall.body).toStrictEqual({
      error: "No Slack workspace installed for this organization",
    });

    const callbackError = await integrations.requestSlackOauthCallback(
      { error: "access_denied" },
      [307],
    );
    expect(callbackError.headers.get("location") ?? "").toContain(
      "/slack/failed?error=access_denied",
    );

    const callbackMissingCode = await integrations.requestSlackOauthCallback(
      {},
      [400],
    );
    expect(callbackMissingCode.body).toStrictEqual({
      error: "Missing authorization code",
    });
  });

  it("installs, connects, disconnects, and uninstalls a Slack workspace through OAuth APIs", async () => {
    integrations.configureSlackOauthProvider();
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      channel: "D_BDD_SLACK",
      ts: "1710000000.000100",
    });
    context.mocks.slack.chat.postEphemeral.mockResolvedValue({
      ts: "1710000000.000101",
    });
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });

    const admin = integrations.user();
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin test user to have an organization");
    }
    const member = integrations.user({
      orgId,
      orgRole: "org:member",
    });
    const disconnectedMember = integrations.user({
      orgId,
      orgRole: "org:member",
    });
    const workspaceId = `T_BDD_${randomInt(1_000_000, 9_999_999)}`;
    const workspaceName = `BDD Slack ${workspaceId}`;

    const initialInstall = await integrations.requestSlackOauthInstall(
      {
        orgId,
        vm0UserId: admin.userId,
        prompt: "install prompt",
      },
      [307],
    );
    const initialInstallUrl = new URL(
      initialInstall.headers.get("location") ?? "",
    );
    const botScope = initialInstallUrl.searchParams.get("scope") ?? "";
    expect(initialInstallUrl.hostname).toBe("slack.com");
    expect(botScope).toContain("chat:write");

    const initialAdminStatus = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(initialAdminStatus.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
    });

    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce(
      slackBotOauthResponse({
        accessToken: "xoxb-bdd-slack",
        botUserId: "UBOT_BDD_SLACK",
        workspaceId,
        workspaceName,
        authedUserId: "UADMIN_BDD_SLACK",
        scope: botScope,
      }),
    );
    const installed = await integrations.requestSlackOauthCallback(
      {
        code: "install-code",
        state: JSON.stringify({
          orgId,
          vm0UserId: admin.userId,
          prompt: "install prompt",
        }),
      },
      [307],
    );
    expect(installed.headers.get("location") ?? "").toContain(
      `/settings/slack?status=connected&workspace=${encodeURIComponent(
        workspaceName,
      )}`,
    );

    const adminStatus = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(adminStatus.body).toMatchObject({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      workspaceName,
      scopeMismatch: false,
    });

    const memberOrgStatus = await integrations.requestSlackIntegrationStatus(
      member,
      [200],
    );
    expect(memberOrgStatus.body).toMatchObject({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
    });
    if (!("connectUrl" in memberOrgStatus.body)) {
      throw new Error("Expected Slack member status to include connectUrl");
    }
    expect(memberOrgStatus.body.connectUrl).toContain(
      "/api/zero/slack/oauth/connect",
    );

    const memberConnectStatus = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(memberConnectStatus.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });

    const connectStart = await integrations.requestSlackOauthConnect(
      {
        orgId,
        vm0UserId: member.userId,
        prompt: "p".repeat(700),
      },
      [307],
    );
    const connectStartUrl = new URL(connectStart.headers.get("location") ?? "");
    expect(connectStartUrl.hostname).toBe("slack.com");
    expect(connectStartUrl.searchParams.get("user_scope")).toBe(
      "identity.basic",
    );
    expect(connectStartUrl.searchParams.get("team")).toBe(workspaceId);
    const connectStateText = connectStartUrl.searchParams.get("state") ?? "";
    const connectState: unknown = JSON.parse(connectStateText);
    if (!isRecord(connectState)) {
      throw new Error("Expected Slack connect state object");
    }
    expect(connectState).toMatchObject({
      orgId,
      vm0UserId: member.userId,
      flow: "connect",
    });
    expect(String(connectState.prompt ?? "")).toHaveLength(500);

    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce(
      slackUserOauthResponse({
        workspaceId,
        authedUserId: "UMEMBER_BDD_SLACK",
      }),
    );
    const connected = await integrations.requestSlackOauthCallback(
      {
        code: "member-connect-code",
        state: JSON.stringify({
          orgId,
          vm0UserId: member.userId,
          flow: "connect",
          prompt: "member prompt",
        }),
      },
      [307],
    );
    expect(connected.headers.get("location") ?? "").toContain(
      `/settings/slack?status=connected&workspace=${encodeURIComponent(
        workspaceName,
      )}`,
    );

    const connectedMemberStatus = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(connectedMemberStatus.body).toMatchObject({
      isConnected: true,
      isAdmin: false,
      workspaceName,
    });

    const disconnectedBeforeWrongTeam =
      await integrations.requestSlackConnectStatus(disconnectedMember, [200]);
    expect(disconnectedBeforeWrongTeam.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });
    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce(
      slackUserOauthResponse({
        workspaceId: "T_OTHER_BDD_SLACK",
        authedUserId: "UOTHER_BDD_SLACK",
      }),
    );
    const wrongTeam = await integrations.requestSlackOauthCallback(
      {
        code: "wrong-team-code",
        state: JSON.stringify({
          orgId,
          vm0UserId: disconnectedMember.userId,
          flow: "connect",
        }),
      },
      [307],
    );
    expect(wrongTeam.headers.get("location") ?? "").toContain(
      "different%20Slack%20workspace",
    );
    const disconnectedAfterWrongTeam =
      await integrations.requestSlackConnectStatus(disconnectedMember, [200]);
    expect(disconnectedAfterWrongTeam.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });

    const disconnected = await integrations.requestSlackDisconnect(
      member,
      undefined,
      [200],
    );
    expect(disconnected.body).toStrictEqual({ ok: true });
    const memberAfterDisconnect = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(memberAfterDisconnect.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });

    const uninstalled = await integrations.requestSlackDisconnect(
      admin,
      "uninstall",
      [200],
    );
    expect(uninstalled.body).toStrictEqual({ ok: true });
    const adminAfterUninstall =
      await integrations.requestSlackIntegrationStatus(admin, [200]);
    expect(adminAfterUninstall.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
    });
  });
});

describe("INT-02: Telegram integration", () => {
  it("keeps unauthenticated, missing bot, unlinked bot, and missing upload errors visible through APIs", async () => {
    const actor = integrations.user();
    const missingBotId = "999999999";

    const unauthorized = await integrations.requestReadTelegramBot(
      null,
      missingBotId,
      [401],
    );
    expect(unauthorized.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingBot = await integrations.requestReadTelegramBot(
      actor,
      missingBotId,
      [404],
    );
    expect(missingBot.body).toStrictEqual({
      error: {
        message: "Telegram bot not found",
        code: "NOT_FOUND",
      },
    });

    const linkStatus = await integrations.readTelegramLinkStatus(
      actor,
      missingBotId,
    );
    expect(linkStatus).toMatchObject({ linked: false });

    const missingUpload = await integrations.requestTelegramUploadComplete(
      actor,
      {
        uploadId: "11111111-1111-4111-8111-111111111111",
        botId: missingBotId,
        chatId: "12345",
      },
      [404],
    );
    expect(missingUpload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("keeps Telegram webhook missing, auth, and no-op update boundaries visible", async () => {
    const missingCustomBot = await integrations.requestTelegramWebhook(
      "999999999",
      "{}",
      { "x-telegram-bot-api-secret-token": "missing-custom-secret" },
      [404],
    );
    expect(missingCustomBot.body).toBe("Not Found");

    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", undefined);
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", undefined);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", undefined);

    const unconfigured = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "{}",
      {},
      [404],
    );
    expect(unconfigured.body).toBe("Not Found");

    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", "123456:bdd-token");
    mockEnv(
      "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
      TELEGRAM_OFFICIAL_WEBHOOK_SECRET,
    );
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "bdd_official_bot");

    const unauthorized = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "{}",
      {},
      [401],
    );
    expect(unauthorized.body).toBe("Unauthorized");

    const invalidSecret = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "{}",
      { "x-telegram-bot-api-secret-token": "bad-secret" },
      [401],
    );
    expect(invalidSecret.body).toBe("Unauthorized");

    const invalidJson = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "not-json",
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [400],
    );
    expect(invalidJson.body).toBe("Bad Request");

    const invalidUpdate = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      "null",
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [400],
    );
    expect(invalidUpdate.body).toBe("Bad Request");

    const noMessage = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({ update_id: 1001 }),
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [200],
    );
    expect(noMessage.body).toBe("OK");

    const noContentMessage = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({
        update_id: 1002,
        message: {
          message_id: 42,
          chat: { id: 12_345, type: "private" },
          from: { id: 54_321, first_name: "BDD" },
        },
      }),
      { "x-telegram-bot-api-secret-token": TELEGRAM_OFFICIAL_WEBHOOK_SECRET },
      [200],
    );
    expect(noContentMessage.body).toBe("OK");
  });

  it("registers and manages a Telegram bot through API-visible state", async () => {
    server.use(telegramDomainProbe(), telegramSendMessage());
    bdd.acceptAgentStorageWrites();

    const actor = integrations.user();
    const member = integrations.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Telegram agent",
    });
    const botId = String(TELEGRAM_BOT_ID);

    const unauthenticatedList =
      await integrations.requestListTelegramIntegrations(null, [401]);
    expect(unauthenticatedList.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const initialList = await integrations.requestListTelegramIntegrations(
      actor,
      [200],
    );
    if (!("bots" in initialList.body)) {
      throw new Error("Expected Telegram integration list response");
    }
    expect(initialList.body.bots).toContainEqual(
      expect.objectContaining({
        id: OFFICIAL_TELEGRAM_BOT_ID,
        kind: "official",
        isConnected: false,
      }),
    );

    const officialStatus = await integrations.requestReadTelegramBot(
      actor,
      OFFICIAL_TELEGRAM_BOT_ID,
      [200],
    );
    expect(officialStatus.body).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      tokenStatus: "unknown",
      official: { configured: false },
    });

    const officialUpdateWithoutAgent =
      await integrations.requestUpdateTelegramBot(
        actor,
        OFFICIAL_TELEGRAM_BOT_ID,
        {},
        [400],
      );
    expect(officialUpdateWithoutAgent.body).toStrictEqual({
      error: {
        message: "selectedAgentId is required",
        code: "BAD_REQUEST",
      },
    });

    const officialDisconnect = await integrations.requestDisconnectTelegramBot(
      actor,
      OFFICIAL_TELEGRAM_BOT_ID,
      [403],
    );
    expect(officialDisconnect.body).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const officialLink = await integrations.requestLinkTelegram(
      actor,
      { telegramBotId: OFFICIAL_TELEGRAM_BOT_ID },
      [404],
    );
    expect(officialLink.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const authCallback = await integrations.requestTelegramAuthCallback([200]);
    expect(authCallback.body).toContain("telegram-auth");

    context.mocks.telegram.getMe.mockRejectedValueOnce(new Error("invalid"));
    const invalidSetup = await integrations.requestTelegramSetupStatus(
      actor,
      { botToken: "bad-token" },
      [400],
    );
    expect(invalidSetup.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    context.mocks.telegram.getMe.mockResolvedValue({
      id: TELEGRAM_BOT_ID,
      username: "bdd_telegram_bot",
      can_read_all_group_messages: true,
    });
    let registeredTelegramWebhookSecret: string | undefined;
    context.mocks.telegram.setWebhook.mockImplementation(
      (...args: readonly unknown[]) => {
        const webhookSecret = args[2];
        if (typeof webhookSecret === "string") {
          registeredTelegramWebhookSecret = webhookSecret;
        }
        return Promise.resolve();
      },
    );

    const unauthenticatedRegister =
      await integrations.requestRegisterTelegramBot(
        null,
        {
          botToken: TELEGRAM_BOT_TOKEN,
          defaultAgentId: agent.agentId,
        },
        [401],
      );
    expect(unauthenticatedRegister.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const setup = await integrations.requestTelegramSetupStatus(
      actor,
      {
        botToken: TELEGRAM_BOT_TOKEN,
        origin: "https://app.example.test/setup",
      },
      [200],
    );
    expect(setup.body).toStrictEqual({
      id: botId,
      username: "bdd_telegram_bot",
      domainConfigured: true,
      privacyDisabled: true,
    });

    const registered = await integrations.requestRegisterTelegramBot(
      actor,
      {
        botToken: TELEGRAM_BOT_TOKEN,
        defaultAgentId: agent.agentId,
      },
      [201],
    );
    expect(registered.body).toMatchObject({
      id: botId,
      username: "bdd_telegram_bot",
      isOwner: true,
      isConnected: false,
      tokenStatus: "valid",
      domainConfigured: true,
      agent: { id: agent.agentId },
    });
    if (!registeredTelegramWebhookSecret) {
      throw new Error("Expected Telegram registration to configure webhook");
    }

    const customWebhookUnauthorized = await integrations.requestTelegramWebhook(
      botId,
      "{}",
      { "x-telegram-bot-api-secret-token": "bad-custom-secret" },
      [401],
    );
    expect(customWebhookUnauthorized.body).toBe("Unauthorized");

    const customWebhookNoMessage = await integrations.requestTelegramWebhook(
      botId,
      JSON.stringify({ update_id: 2001 }),
      {
        "x-telegram-bot-api-secret-token": registeredTelegramWebhookSecret,
      },
      [200],
    );
    expect(customWebhookNoMessage.body).toBe("OK");

    const customWebhookNoContentMessage =
      await integrations.requestTelegramWebhook(
        botId,
        JSON.stringify({
          update_id: 2002,
          message: {
            message_id: 77,
            chat: { id: 12_345, type: "private" },
            from: { id: 54_321, first_name: "BDD" },
          },
        }),
        {
          "x-telegram-bot-api-secret-token": registeredTelegramWebhookSecret,
        },
        [200],
      );
    expect(customWebhookNoContentMessage.body).toBe("OK");

    const listed = await integrations.requestListTelegramIntegrations(
      actor,
      [200],
    );
    if (!("bots" in listed.body)) {
      throw new Error("Expected Telegram integration list response");
    }
    expect(listed.body.bots).toContainEqual(
      expect.objectContaining({
        id: botId,
        username: "bdd_telegram_bot",
        isOwner: true,
      }),
    );

    const zeroTokenList = await integrations.requestListTelegramBots(
      actor,
      [200],
    );
    if (!("bots" in zeroTokenList.body)) {
      throw new Error("Expected Telegram bot list response");
    }
    expect(zeroTokenList.body.bots).toContainEqual(
      expect.objectContaining({
        id: botId,
        username: "bdd_telegram_bot",
      }),
    );

    const customLinkStatus = await integrations.readTelegramLinkStatus(
      actor,
      botId,
    );
    expect(customLinkStatus).toMatchObject({
      linked: false,
      installation: {
        id: botId,
        botUsername: "bdd_telegram_bot",
        loginBotId: botId,
        domainConfigured: true,
      },
    });

    const missingLinkAuth = await integrations.requestLinkTelegram(
      actor,
      { telegramBotId: botId },
      [400],
    );
    expect(missingLinkAuth.body).toStrictEqual({
      error: {
        message: "Either telegramAuth or connectSignature is required",
        code: "BAD_REQUEST",
      },
    });

    const invalidConnectSignature = await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: botId,
        connectSignature: {
          telegramUserId: "12345",
          telegramUsername: "bdd_telegram_user",
          timestamp: Math.floor(now() / 1000),
          signature: "bad-signature",
        },
      },
      [400],
    );
    expect(invalidConnectSignature.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const invalidTelegramAuth = await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: botId,
        telegramAuth: {
          id: 12_345,
          first_name: "BDD",
          username: "bdd_telegram_user",
          auth_date: Math.floor(now() / 1000),
          hash: "bad-hash",
        },
      },
      [400],
    );
    expect(invalidTelegramAuth.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const missingUnlink = await integrations.requestUnlinkTelegram(
      actor,
      botId,
      [404],
    );
    expect(missingUnlink.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingDefaultAgent = await integrations.requestUpdateTelegramBot(
      actor,
      botId,
      {},
      [400],
    );
    expect(missingDefaultAgent.body).toStrictEqual({
      error: {
        message: "defaultAgentId is required",
        code: "BAD_REQUEST",
      },
    });

    const memberUpdate = await integrations.requestUpdateTelegramBot(
      member,
      botId,
      { defaultAgentId: agent.agentId },
      [403],
    );
    expect(memberUpdate.body).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const updated = await integrations.requestUpdateTelegramBot(
      actor,
      botId,
      { defaultAgentId: agent.agentId },
      [200],
    );
    expect(updated.body).toMatchObject({
      id: botId,
      agent: { id: agent.agentId },
    });

    const uploadInit = await integrations.requestTelegramUploadInit(
      actor,
      {
        filename: "telegram-note.txt",
        contentType: "text/plain",
        length: 12,
      },
      [200],
    );
    expect(uploadInit.body).toMatchObject({
      filename: "telegram-note.txt",
      contentType: "text/plain",
      size: 12,
    });
    if (!("uploadUrl" in uploadInit.body)) {
      throw new Error("Expected Telegram upload init response");
    }
    expect(uploadInit.body.uploadUrl).toMatch(/^https?:\/\//);

    const sentMessage = await integrations.requestSendTelegramMessage(
      actor,
      {
        botId,
        chatId: "12345",
        text: "BDD Telegram message",
        replyToMessageId: 7,
        messageThreadId: 9,
      },
      [200],
    );
    expect(sentMessage.body).toStrictEqual({
      ok: true,
      messageId: 321,
      chatId: "12345",
    });

    if (!("avatarUrl" in registered.body)) {
      throw new Error("Expected Telegram register response");
    }
    const avatarUrl = registered.body.avatarUrl ?? "";
    expect(avatarUrl).not.toBe("");
    const parsedAvatarUrl = new URL(avatarUrl, "http://api.test");
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([]);
    const avatar = await integrations.requestTelegramAvatar(
      null,
      botId,
      {
        exp: parsedAvatarUrl.searchParams.get("exp") ?? undefined,
        sig: parsedAvatarUrl.searchParams.get("sig") ?? undefined,
      },
      [200],
    );
    expect(avatar.headers.get("content-type")).toContain("image/svg+xml");

    const unauthenticatedAvatar = await integrations.requestTelegramAvatar(
      null,
      botId,
      {},
      [401],
    );
    expect(unauthenticatedAvatar.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const missingAvatar = await integrations.requestTelegramAvatar(
      actor,
      "555555555",
      {},
      [404],
    );
    expect(missingAvatar.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const memberDisconnect = await integrations.requestDisconnectTelegramBot(
      member,
      botId,
      [403],
    );
    expect(memberDisconnect.body).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const disconnected = await integrations.requestDisconnectTelegramBot(
      actor,
      botId,
      [204],
    );
    expect(disconnected.status).toBe(204);

    const afterDisconnect = await integrations.requestReadTelegramBot(
      actor,
      botId,
      [404],
    );
    expect(afterDisconnect.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});

describe("INT-03: GitHub and AgentPhone integrations", () => {
  it("keeps GitHub OAuth install and connect-start errors visible through redirects", async () => {
    integrations.clearGithubAppProvider();

    const unconfiguredInstall = await integrations.requestGithubOauthInstall(
      {},
      [503],
    );
    expect(unconfiguredInstall.body).toStrictEqual({
      error: "GitHub App integration is not configured",
    });

    integrations.configureGithubAppInstallProvider();
    const install = await integrations.requestGithubOauthInstall({}, [307]);
    const installLocation = install.headers.get("location") ?? "";
    expect(installLocation).toContain(
      "https://github.com/apps/bdd-github-app/installations/new",
    );
    expect(
      new URL(installLocation).searchParams
        .get("redirect_uri")
        ?.endsWith("/api/github/app/setup/callback"),
    ).toBeTruthy();
    expect(install.headers.get("Cache-Control")).toBe("no-store");

    const admin = integrations.user();
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected GitHub admin test user to have an org");
    }
    const member = integrations.user({
      orgId,
      orgRole: "org:member",
    });
    await integrations.readGithubInstallation(member);
    const nonAdminInstall = await integrations.requestGithubOauthInstall(
      {
        orgId,
        vm0UserId: member.userId,
      },
      [307],
    );
    expect(nonAdminInstall.headers.get("location") ?? "").toContain(
      "Only%20organization%20admins%20can%20install%20GitHub",
    );

    const unauthenticatedConnect = await integrations.requestGithubOauthConnect(
      null,
      {},
      [307],
    );
    expect(unauthenticatedConnect.headers.get("location") ?? "").toContain(
      "/sign-in?redirect_url=",
    );

    const actor = integrations.user();
    const invalidSignedConnect = await integrations.requestGithubOauthConnect(
      actor,
      {
        installation: "12345",
        ghUser: "67890",
      },
      [307],
    );
    expect(invalidSignedConnect.headers.get("location") ?? "").toContain(
      "Invalid%20or%20expired%20GitHub%20connect%20link",
    );

    const timestamp = Math.floor(now() / 1000);
    const validSignedMissingInstallation =
      await integrations.requestGithubOauthConnect(
        actor,
        {
          installation: "12345",
          ghUser: "67890",
          ghLogin: "@bdd-github-user",
          ts: timestamp,
          sig: githubConnectSignature({
            installationId: "12345",
            githubUserId: "67890",
            githubUsername: "@bdd-github-user",
            timestamp,
          }),
        },
        [307],
      );
    expect(
      validSignedMissingInstallation.headers.get("location") ?? "",
    ).toContain("No%20GitHub%20installation%20found%20for%20this%20workspace");

    const unconfiguredConnect = await integrations.requestGithubOauthConnect(
      actor,
      {},
      [307],
    );
    expect(unconfiguredConnect.headers.get("location") ?? "").toContain(
      "GitHub%20OAuth%20is%20not%20configured",
    );
  });

  it("keeps GitHub user OAuth callback errors visible through redirects", async () => {
    const githubError = await integrations.requestGithubOauthConnectCallback(
      {
        error: "access_denied",
        error_description: "User denied access",
      },
      [307],
    );
    expect(githubError.headers.get("location") ?? "").toContain(
      "User%20denied%20access",
    );

    const missingCode = await integrations.requestGithubOauthConnectCallback(
      {},
      [307],
    );
    expect(missingCode.headers.get("location") ?? "").toContain(
      "Missing%20authorization%20code%20from%20GitHub",
    );

    const invalidState = await integrations.requestGithubOauthConnectCallback(
      {
        code: "github-code",
        state: "not-a-valid-state",
      },
      [307],
    );
    expect(invalidState.headers.get("location") ?? "").toContain(
      "Invalid%20OAuth%20state",
    );
  });

  it("keeps GitHub app setup callback errors visible through redirects", async () => {
    integrations.clearGithubAppProvider();
    const unconfiguredSetup = await integrations.requestGithubAppSetupCallback(
      {},
      [307],
    );
    expect(unconfiguredSetup.headers.get("location") ?? "").toContain(
      "GitHub%20App%20integration%20is%20not%20configured",
    );

    integrations.configureGithubAppInstallProvider();
    integrations.configureGithubAppCallbackProvider();

    const updateSetup = await integrations.requestGithubAppSetupCallback(
      { setup_action: "update" },
      [307],
    );
    expect(updateSetup.headers.get("location") ?? "").toContain(
      "/works?github=installed",
    );

    const setupError = await integrations.requestGithubAppSetupCallback(
      {
        error: "setup_denied",
        error_description: "Setup denied",
      },
      [307],
    );
    expect(setupError.headers.get("location") ?? "").toContain(
      "Setup%20denied",
    );

    const setupInvalidState = await integrations.requestGithubAppSetupCallback(
      {
        installation_id: "12345",
        setup_action: "install",
        state: "not-a-valid-state",
      },
      [307],
    );
    expect(setupInvalidState.headers.get("location") ?? "").toContain(
      "Invalid%20OAuth%20state",
    );

    const admin = integrations.user();
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected GitHub admin test user to have an org");
    }
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD GitHub setup agent",
    });
    await integrations.readGithubInstallation(admin);
    const installWithState = await integrations.requestGithubOauthInstall(
      {
        orgId,
        vm0UserId: admin.userId,
        composeId: agent.agentId,
      },
      [307],
    );
    const signedState =
      new URL(installWithState.headers.get("location") ?? "").searchParams.get(
        "state",
      ) ?? "";
    expect(signedState).not.toBe("");

    const parsedSignedState: unknown = JSON.parse(signedState);
    if (!isRecord(parsedSignedState)) {
      throw new Error("Expected signed GitHub state to be an object");
    }
    const tamperedState = JSON.stringify({
      ...parsedSignedState,
      sig: "0".repeat(64),
    });
    const setupTamperedState = await integrations.requestGithubAppSetupCallback(
      {
        installation_id: "12345",
        setup_action: "install",
        state: tamperedState,
      },
      [307],
    );
    expect(setupTamperedState.headers.get("location") ?? "").toContain(
      "Invalid%20state%20signature",
    );

    const installWithoutAgent = await integrations.requestGithubOauthInstall(
      {
        orgId,
        vm0UserId: admin.userId,
      },
      [307],
    );
    const stateWithoutAgent =
      new URL(
        installWithoutAgent.headers.get("location") ?? "",
      ).searchParams.get("state") ?? "";
    expect(stateWithoutAgent).not.toBe("");
    const setupMissingAgent = await integrations.requestGithubAppSetupCallback(
      {
        installation_id: "12345",
        setup_action: "install",
        state: stateWithoutAgent,
      },
      [307],
    );
    expect(setupMissingAgent.headers.get("location") ?? "").toContain(
      "Missing%20default%20agent",
    );

    const requestSetup = await integrations.requestGithubAppSetupCallback(
      {
        setup_action: "request",
        state: signedState,
      },
      [307],
    );
    expect(requestSetup.headers.get("location") ?? "").toContain(
      "permission%20to%20install%20this%20GitHub%20App",
    );

    const missingInstallation =
      await integrations.requestGithubAppSetupCallback(
        {
          setup_action: "install",
          state: signedState,
        },
        [307],
      );
    expect(missingInstallation.headers.get("location") ?? "").toContain(
      "Missing%20installation%20ID%20from%20GitHub",
    );
  });

  it("keeps GitHub no-install management and upload-init surfaces visible through APIs", async () => {
    const actor = integrations.user();

    const installation = await integrations.readGithubInstallation(actor);
    expect(installation.status).toBe(404);
    expect(installation.body).toMatchObject({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
    });

    const unauthorizedPatch =
      await integrations.requestUpdateGithubInstallation(
        null,
        { agentName: "bdd-agent" },
        [401],
      );
    expect(unauthorizedPatch.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const upload = await integrations.requestGithubUploadInit(
      actor,
      {
        filename: "artifact.txt",
        contentType: "text/plain",
        length: 10,
      },
      [200],
    );
    expect(upload.body).toMatchObject({
      filename: "artifact.txt",
      contentType: "text/plain",
      size: 10,
    });
    expect("uploadUrl" in upload.body ? upload.body.uploadUrl : "").toMatch(
      /^https?:\/\//,
    );

    const uploadId =
      "uploadId" in upload.body
        ? upload.body.uploadId
        : "22222222-2222-4222-8222-222222222222";
    const complete = await integrations.requestGithubUploadComplete(
      actor,
      {
        uploadId,
        repo: "vm0-ai/vm0",
        issueNumber: 1,
        caption: "BDD GitHub upload",
      },
      [404],
    );
    expect(complete.body).toStrictEqual({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
    });
  });

  it("keeps AgentPhone status, invalid connect, auth, and unlinked-send errors visible through APIs", async () => {
    const actor = integrations.user();
    integrations.configureAgentPhoneProvider();

    const initialStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(initialStatus).toStrictEqual({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    const invalidConnect = await integrations.requestConnectAgentPhone(
      actor,
      {
        phoneHandle: "+15555551212",
        agentphoneAgentId: "agt-bdd-agentphone",
        timestamp: Math.floor(now() / 1000),
        signature: "bad-signature",
        channel: "sms",
      },
      [400],
    );
    expect(invalidConnect.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const unauthorizedMessage = await integrations.requestSendPhoneMessage(
      null,
      {
        toNumber: "+15555551212",
        text: "BDD AgentPhone message",
      },
      [401],
    );
    expect(unauthorizedMessage.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const unlinkedSend = await integrations.requestSendPhoneMessage(
      actor,
      {
        toNumber: "+15555551212",
        text: "not linked",
      },
      [404],
    );
    expect(unlinkedSend.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const uploadInit = await integrations.requestPhoneUploadInit(
      actor,
      {
        filename: "agentphone-note.txt",
        contentType: "text/plain",
        length: 13,
      },
      [200],
    );
    expect(uploadInit.body).toMatchObject({
      filename: "agentphone-note.txt",
      contentType: "text/plain",
      size: 13,
    });
    expect(
      "uploadUrl" in uploadInit.body ? uploadInit.body.uploadUrl : "",
    ).toMatch(/^https?:\/\//);

    const phoneUploadId =
      "uploadId" in uploadInit.body
        ? uploadInit.body.uploadId
        : "33333333-3333-4333-8333-333333333333";
    context.mocks.s3.send.mockResolvedValue({ Contents: [] });
    const missingUpload = await integrations.requestPhoneUploadComplete(
      actor,
      {
        uploadId: phoneUploadId,
        toNumber: "+15555551212",
        caption: "BDD AgentPhone upload",
      },
      [404],
    );
    expect(missingUpload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const missingDownload = await integrations.requestPhoneDownloadFile(
      actor,
      "missing-agentphone-file",
      [404],
    );
    expect(missingDownload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("keeps AgentPhone start-link, unlink, and webhook boundaries visible through APIs", async () => {
    const actor = integrations.user();
    integrations.clearAgentPhoneProvider();

    const unauthorizedStart = await integrations.requestStartAgentPhoneLink(
      null,
      { phoneHandle: "+15555551212" },
      [401],
    );
    expect(unauthorizedStart.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const invalidPhone = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle: "not-a-phone" },
      [400],
    );
    expect(invalidPhone.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const notConfigured = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle: "+15555551212" },
      [503],
    );
    expect(notConfigured.body).toStrictEqual({
      error: {
        message: "AgentPhone is not configured",
        code: "NOT_CONFIGURED",
      },
    });

    integrations.configureAgentPhoneProvider();
    let connectUrl: string | undefined;
    server.use(
      agentPhoneVerificationSend(200, (body) => {
        if (!isRecord(body) || typeof body.body !== "string") {
          return;
        }
        const match = body.body.match(/https?:\/\/\S+/u);
        if (match) {
          connectUrl = match[0];
        }
      }),
    );
    const phoneHandle = uniquePhoneHandle();
    const sent = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle },
      [200],
    );
    expect(sent.body).toStrictEqual({
      phoneHandle,
      verificationSent: true,
    });

    const cooledDown = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle },
      [429],
    );
    expect(cooledDown.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });

    if (!connectUrl) {
      throw new Error("Expected AgentPhone verification text to include a URL");
    }
    const connectParams = new URL(connectUrl).searchParams;
    const timestamp = Number(connectParams.get("ts") ?? "");
    if (!Number.isFinite(timestamp)) {
      throw new Error("Expected AgentPhone connect URL to include timestamp");
    }
    const connectBody = {
      phoneHandle: connectParams.get("handle") ?? "",
      agentphoneAgentId: connectParams.get("agent") ?? "",
      timestamp,
      signature: connectParams.get("sig") ?? "",
      channel: connectParams.get("channel") ?? undefined,
    };
    const connected = await integrations.requestConnectAgentPhone(
      actor,
      connectBody,
      [200],
    );
    expect(connected.body).toStrictEqual({ phoneHandle });

    const linkedStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(linkedStatus).toStrictEqual({
      linked: true,
      phoneHandle,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    const missingAgentMessage = await integrations.requestSendPhoneMessage(
      actor,
      {
        toNumber: phoneHandle,
        text: "BDD AgentPhone missing agent",
      },
      [404],
    );
    expect(missingAgentMessage.body).toStrictEqual({
      error: {
        message: "AgentPhone agent not found",
        code: "NOT_FOUND",
      },
    });

    const sentPhoneMessage = await integrations.requestSendPhoneMessage(
      actor,
      {
        agentphoneAgentId: connectBody.agentphoneAgentId,
        toNumber: phoneHandle,
        text: "BDD linked AgentPhone message",
      },
      [200],
    );
    expect(sentPhoneMessage.body).toStrictEqual({
      ok: true,
      messageId: "msg-bdd-agentphone",
      channel: "sms",
      toNumber: phoneHandle,
    });

    server.use(agentPhoneVerificationSend(503));
    const failedPhoneMessage = await integrations.requestSendPhoneMessage(
      actor,
      {
        agentphoneAgentId: connectBody.agentphoneAgentId,
        toNumber: phoneHandle,
        text: "BDD AgentPhone provider failure",
      },
      [502],
    );
    expect(failedPhoneMessage.body).toMatchObject({
      error: { code: "AGENTPHONE_ERROR" },
    });

    const duplicateConnect = await integrations.requestConnectAgentPhone(
      integrations.user(),
      connectBody,
      [409],
    );
    expect(duplicateConnect.body).toMatchObject({
      error: { code: "CONFLICT" },
    });

    const alreadyLinkedStart = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle: uniquePhoneHandle() },
      [409],
    );
    expect(alreadyLinkedStart.body).toMatchObject({
      error: { code: "CONFLICT" },
    });

    const disconnected = await integrations.requestUnlinkAgentPhone(
      actor,
      [204],
    );
    expect(disconnected.body).toBeUndefined();

    const unlinkedStatus = await integrations.getAgentPhoneLinkStatus(actor);
    expect(unlinkedStatus).toStrictEqual({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    const missingUnlink = await integrations.requestUnlinkAgentPhone(
      actor,
      [404],
    );
    expect(missingUnlink.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unavailable = await integrations.requestStartAgentPhoneLink(
      integrations.user(),
      { phoneHandle: uniquePhoneHandle() },
      [503],
    );
    expect(unavailable.body).toStrictEqual({
      error: {
        message: "AgentPhone verification text could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    });

    const noConfigWebhook = await integrations.requestAgentPhoneWebhook(
      "{}",
      {},
      [404],
    );
    expect(noConfigWebhook.body).toBe("Not Found");

    integrations.configureAgentPhoneWebhook();
    const rawMessage = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        agentId: "agt-bdd-agentphone",
        from: "+15555551212",
        to: "+19039853128",
        message: "hello",
      },
    });

    const invalidSignature = await integrations.requestAgentPhoneWebhook(
      rawMessage,
      {
        "x-webhook-signature": "bad-signature",
        "x-webhook-timestamp": String(Math.floor(now() / 1000)),
      },
      [401],
    );
    expect(invalidSignature.body).toBe("Unauthorized");

    const malformed = await integrations.requestAgentPhoneWebhook(
      "not-json",
      agentPhoneWebhookHeaders("not-json"),
      [400],
    );
    expect(malformed.body).toBe("Bad Request");

    const ignoredLifecycleEvent = JSON.stringify({
      event: "agent.status",
      data: { agentId: "agt-bdd-agentphone" },
    });
    const ignoredLifecycle = await integrations.requestAgentPhoneWebhook(
      ignoredLifecycleEvent,
      agentPhoneWebhookHeaders(
        ignoredLifecycleEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(ignoredLifecycle.body).toBe("OK");

    const unsupportedChannelEvent = JSON.stringify({
      event: "agent.message",
      channel: "fax",
      data: {
        agentId: "agt-bdd-agentphone",
        from: "+15555551212",
        to: "+19039853128",
        message: "unsupported channel",
      },
    });
    const unsupportedChannel = await integrations.requestAgentPhoneWebhook(
      unsupportedChannelEvent,
      agentPhoneWebhookHeaders(
        unsupportedChannelEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(unsupportedChannel.body).toBe("OK");

    const missingFieldsEvent = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        agentId: "agt-bdd-agentphone",
        to: "+19039853128",
        message: "missing sender",
      },
    });
    const missingFields = await integrations.requestAgentPhoneWebhook(
      missingFieldsEvent,
      agentPhoneWebhookHeaders(
        missingFieldsEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(missingFields.body).toBe("OK");

    const wrongDestinationEvent = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        agentId: "agt-bdd-agentphone",
        from: "+15555551212",
        to: "+15555550000",
        message: "wrong destination",
      },
    });
    const wrongDestination = await integrations.requestAgentPhoneWebhook(
      wrongDestinationEvent,
      agentPhoneWebhookHeaders(
        wrongDestinationEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(wrongDestination.body).toBe("OK");

    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    server.use(agentPhoneVerificationSend());
    const smsWebhookId = `evt-bdd-agentphone-${randomUUID()}`;
    const incomingSmsEvent = JSON.stringify({
      event: "agent.message",
      channel: "sms",
      data: {
        id: `msg-bdd-agentphone-${randomUUID()}`,
        agentId: "agt-bdd-agentphone",
        from: uniquePhoneHandle(),
        to: "+19039853128",
        message: "/connect",
      },
    });
    const incomingSms = await integrations.requestAgentPhoneWebhook(
      incomingSmsEvent,
      agentPhoneWebhookHeaders(incomingSmsEvent, smsWebhookId),
      [200],
    );
    expect(incomingSms.body).toBe("OK");

    const duplicateSms = await integrations.requestAgentPhoneWebhook(
      incomingSmsEvent,
      agentPhoneWebhookHeaders(incomingSmsEvent, smsWebhookId),
      [200],
    );
    expect(duplicateSms.body).toBe("OK");

    const unmentionedGroupEvent = JSON.stringify({
      event: "agent.message",
      channel: "imessage",
      data: {
        id: `msg-bdd-agentphone-${randomUUID()}`,
        agentId: "agt-bdd-agentphone",
        from: `sender-${randomUUID()}@example.test`,
        to: "+19039853128",
        message: "group update without a Zero mention",
        conversationId: `group-${randomUUID()}`,
        isGroup: true,
        mentioned: false,
      },
    });
    const unmentionedGroup = await integrations.requestAgentPhoneWebhook(
      unmentionedGroupEvent,
      agentPhoneWebhookHeaders(
        unmentionedGroupEvent,
        `evt-bdd-agentphone-${randomUUID()}`,
      ),
      [200],
    );
    expect(unmentionedGroup.body).toBe("OK");
  });
});
