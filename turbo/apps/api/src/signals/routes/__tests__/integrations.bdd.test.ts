import { createHmac } from "node:crypto";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

/*
helper gap:
- INT-01 Slack installed-workspace, browser-connect, upload-complete, and
  internal Slack org callback happy paths still need a public API setup journey
  that does not use test-state DB seed routes.
- INT-02 Telegram linked-bot, message/upload success, internal callback, and
  cleanup flows still need public API setup helpers for bot installation state.
- INT-03 GitHub installed-app and AgentPhone linked-send happy paths need public
  setup APIs for provider installation/linkage state before they can be covered
  without diagnostic fixture routes.
*/

const context = testContext();
const bdd = createBddApi(context);
const integrations = createBddIntegrationApi(context);
const AGENTPHONE_WEBHOOK_SECRET = "agentphone-bdd-secret";
const TELEGRAM_BOT_ID = 99_887_766;
const TELEGRAM_BOT_TOKEN = `${TELEGRAM_BOT_ID}:bdd-token`;

interface SlackEphemeralBody {
  readonly response_type: "ephemeral";
  readonly blocks: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function serializedTsRestBody(body: string): string {
  return JSON.stringify(body);
}

function agentPhoneWebhookHeaders(body: string): {
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
      .update(`${timestamp}.${serializedTsRestBody(body)}`)
      .digest("hex")}`,
    "x-webhook-timestamp": timestamp,
    "x-webhook-event": "agent.message",
    "x-webhook-id": "evt-bdd-agentphone",
  };
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

    const commandBody = new URLSearchParams({
      team_id: "TBDD",
      channel_id: "CBDD",
      user_id: "UBDD",
      text: "help",
      trigger_id: "trigger-bdd",
    }).toString();
    const help = await integrations.requestSlackCommand(
      commandBody,
      integrations.signedSlackIngressHeaders(commandBody),
      [200],
    );
    expectSlackEphemeral(help.body);
    expect(help.body.blocks.length).toBeGreaterThan(0);

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

    const nonAdminDisconnect = await integrations.requestSlackDisconnect(
      member,
      "delete",
      [404],
    );
    expect(nonAdminDisconnect.body).toMatchObject({
      error: { code: "NOT_FOUND" },
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
  it("keeps GitHub OAuth install, connect, and callback errors visible through redirects", async () => {
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

    const unconfiguredConnect = await integrations.requestGithubOauthConnect(
      actor,
      {},
      [307],
    );
    expect(unconfiguredConnect.headers.get("location") ?? "").toContain(
      "GitHub%20OAuth%20is%20not%20configured",
    );

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

    integrations.clearGithubAppProvider();
    const unconfiguredSetup = await integrations.requestGithubAppSetupCallback(
      {},
      [307],
    );
    expect(unconfiguredSetup.headers.get("location") ?? "").toContain(
      "GitHub%20App%20integration%20is%20not%20configured",
    );

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

    const missingUnlink = await integrations.requestUnlinkAgentPhone(
      actor,
      [404],
    );
    expect(missingUnlink.body).toMatchObject({
      error: { code: "NOT_FOUND" },
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
  });
});
