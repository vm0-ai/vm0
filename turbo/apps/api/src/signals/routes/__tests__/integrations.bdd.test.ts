import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { settle } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import {
  agentPhoneBddWebhookSecret,
  createBddIntegrationApi,
  telegramLoginAuth,
  type ForwardedInternalCallback,
} from "./helpers/api-bdd-integrations";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

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
const runs = createRunsAutomationsApi(context);
const webhooks = createWebhookCallbackApi(context);
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

interface SlackModalSelectState {
  readonly triggerId: string | null;
  readonly callbackId: string | null;
  readonly privateMetadata: string | null;
  readonly optionValues: readonly string[];
  readonly optionLabels: readonly string[];
  readonly initialOptionValue: string | null;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function latestSlackModal(): SlackModalSelectState {
  const call: unknown = context.mocks.slack.views.open.mock.calls.at(-1)?.[0];
  if (!isRecord(call)) {
    throw new Error("Expected Slack views.open to be called with a modal");
  }
  const view = isRecord(call.view) ? call.view : {};
  const blocks = Array.isArray(view.blocks) ? view.blocks : [];
  const optionValues: string[] = [];
  const optionLabels: string[] = [];
  let initialOptionValue: string | null = null;
  for (const block of blocks) {
    if (!isRecord(block) || !isRecord(block.element)) {
      continue;
    }
    const element = block.element;
    if (isRecord(element.initial_option)) {
      initialOptionValue =
        readStringField(element.initial_option, "value") ?? initialOptionValue;
    }
    if (!Array.isArray(element.options)) {
      continue;
    }
    for (const option of element.options) {
      if (!isRecord(option)) {
        continue;
      }
      const value = readStringField(option, "value");
      if (value !== null) {
        optionValues.push(value);
      }
      const label = isRecord(option.text)
        ? readStringField(option.text, "text")
        : null;
      if (label !== null) {
        optionLabels.push(label);
      }
    }
  }
  return {
    triggerId: readStringField(call, "trigger_id"),
    callbackId: readStringField(view, "callback_id"),
    privateMetadata: readStringField(view, "private_metadata"),
    optionValues,
    optionLabels,
    initialOptionValue,
  };
}

function uniqueSlackUserId(): string {
  return `U_BDD_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function slackPostMessageCallsJson(): string {
  return JSON.stringify(context.mocks.slack.chat.postMessage.mock.calls);
}

function slackOrgCallbackDeliveries(
  log: readonly ForwardedInternalCallback[],
): readonly ForwardedInternalCallback[] {
  return log.filter((entry) => {
    return entry.path === "/api/internal/callbacks/slack/org";
  });
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  await expect
    .poll(async () => {
      const result = await settle(Promise.resolve().then(assertion));
      return result.ok;
    })
    .toBe(true);
}

async function waitForSlackOrgCallback(
  log: readonly ForwardedInternalCallback[],
  expected: ForwardedInternalCallback,
): Promise<void> {
  await waitForExpectation(() => {
    expect(slackOrgCallbackDeliveries(log).at(-1)).toStrictEqual(expected);
  });
}

async function pollRunnerRun(
  runnerGroup: string,
  message: string,
): Promise<string> {
  await runs.heartbeatRunner(runnerGroup);
  let runId: string | undefined;
  await expect
    .poll(async () => {
      const poll = await runs.pollRunner(runnerGroup);
      runId = poll.body.job?.runId;
      return runId ?? null;
    })
    .not.toBeNull();
  if (!runId) {
    throw new Error(message);
  }
  return runId;
}

async function pollSlackRun(runnerGroup: string): Promise<string> {
  return await pollRunnerRun(
    runnerGroup,
    "Expected a Slack-triggered run in the runner queue",
  );
}

async function completeSlackTriggeredRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly cliAgentType: string;
}): Promise<void> {
  const sandboxHeaders = {
    authorization: `Bearer ${args.sandboxToken}`,
  };
  await webhooks.requestAgentCheckpoint(
    {
      runId: args.runId,
      cliAgentType: args.cliAgentType,
      cliAgentSessionId: `bdd-slack-cli-${args.runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`bdd slack history ${args.runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId: args.runId, exitCode: 0 },
    sandboxHeaders,
    [200],
  );
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
      agentPhoneBddWebhookSecret(),
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
    mockOptionalEnv("SLACK_SIGNING_SECRET", undefined);
    const unconfigured = await integrations.requestSlackEvent("{}", {}, [503]);
    expect(unconfigured.body).toStrictEqual({
      error: "Slack integration is not configured",
    });

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

    const staleTimestamp = String(Math.floor(now() / 1000) - 301);
    const staleSignature = await integrations.requestSlackEvent(
      body,
      integrations.signedSlackIngressHeaders(body, staleTimestamp),
      [401],
    );
    expect(staleSignature.body).toStrictEqual({
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

    const invalidJson = await integrations.requestSlackEvent(
      "not-json",
      integrations.signedSlackIngressHeaders("not-json"),
      [400],
    );
    expect(invalidJson.body).toStrictEqual({
      error: "Invalid JSON payload",
    });

    const eventCallbackBody = (event: unknown) => {
      return JSON.stringify({
        type: "event_callback",
        team_id: "TBDD_EVENT",
        event,
      });
    };

    const retryBody = eventCallbackBody({
      type: "app_mention",
      user: "UBDD_EVENT",
      text: "@Zero retry",
      ts: "1710000000.000200",
      channel: "CBDD_EVENT",
      channel_type: "channel",
    });
    const retried = await integrations.requestSlackEvent(
      retryBody,
      {
        ...integrations.signedSlackIngressHeaders(retryBody),
        "x-slack-retry-num": "1",
      },
      [200],
    );
    expect(retried.body).toBe("OK");

    const appHomeBody = eventCallbackBody({
      type: "app_home_opened",
      user: "UBDD_EVENT",
      tab: "home",
      channel: "DBDD_EVENT",
    });
    const appHome = await integrations.requestSlackEvent(
      appHomeBody,
      integrations.signedSlackIngressHeaders(appHomeBody),
      [200],
    );
    expect(appHome.body).toBe("OK");

    const messagesTabBody = eventCallbackBody({
      type: "app_home_opened",
      user: "UBDD_EVENT",
      tab: "messages",
      channel: "DBDD_EVENT",
    });
    const messagesTab = await integrations.requestSlackEvent(
      messagesTabBody,
      integrations.signedSlackIngressHeaders(messagesTabBody),
      [200],
    );
    expect(messagesTab.body).toBe("OK");

    const uninstalledBody = eventCallbackBody({ type: "app_uninstalled" });
    const uninstalled = await integrations.requestSlackEvent(
      uninstalledBody,
      integrations.signedSlackIngressHeaders(uninstalledBody),
      [200],
    );
    expect(uninstalled.body).toBe("OK");

    const tokenRevokedBody = eventCallbackBody({
      type: "tokens_revoked",
      tokens: { bot: ["UBOT_BDD_EVENT"] },
    });
    const tokenRevoked = await integrations.requestSlackEvent(
      tokenRevokedBody,
      integrations.signedSlackIngressHeaders(tokenRevokedBody),
      [200],
    );
    expect(tokenRevoked.body).toBe("OK");

    const ignoredBody = JSON.stringify({ type: "team_join" });
    const ignored = await integrations.requestSlackEvent(
      ignoredBody,
      integrations.signedSlackIngressHeaders(ignoredBody),
      [200],
    );
    expect(ignored.body).toBe("OK");
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

describe("INT-01: Slack app deep webhook flows", () => {
  it("runs Slack mentions through sessions, agent overrides, and model routing", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    integrations.forwardSlackInternalCallbacks();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    const onboarding = await bdd.readOnboardingStatus(actor);
    if (!onboarding.defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Switch Agent",
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_RUNS";
    const threadTs = "3000.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "summarize this thread",
      ts: threadTs,
      channel: channelId,
    });
    await waitForExpectation(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: channelId,
          thread_ts: threadTs,
          status: "is thinking...",
        }),
      );
    });
    const run1Id = await pollSlackRun(runnerGroup);
    const claim1 = await runs.claimRunnerJob(run1Id);
    expect(claim1.prompt).toBe("summarize this thread");
    expect(claim1.appendSystemPrompt ?? "").toContain(
      "You are currently running inside: Slack",
    );
    expect(claim1.appendSystemPrompt ?? "").toContain(
      "Slack display name: Slack User",
    );
    expect(claim1.cliAgentType).toBe("claude-code");
    expect(claim1.environment).toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/.+/),
    });
    const running = await runs.readRun(actor, run1Id);
    expect(running.status).toBe("running");
    const slackState = await integrations.readSlackTestState(teamId);
    expect(slackState.recent_runs).toContainEqual(
      expect.objectContaining({ id: run1Id, triggerSource: "slack" }),
    );

    await completeSlackTriggeredRun({
      runId: run1Id,
      sandboxToken: claim1.sandboxToken,
      cliAgentType: "claude-code",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: channelId, thread_ts: threadTs }),
      );
    });
    const run1 = await runs.readRun(actor, run1Id);
    expect(run1.status).toBe("completed");
    const session1 = run1.result?.agentSessionId;
    if (!session1) {
      throw new Error("Expected completed Slack run to expose its session");
    }

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "follow up in the same thread",
      ts: "3000.000200",
      thread_ts: threadTs,
      channel: channelId,
    });
    const run2Id = await pollSlackRun(runnerGroup);
    const claim2 = await runs.claimRunnerJob(run2Id);
    expect(claim2.resumeSession?.sessionId).toBe(`bdd-slack-cli-${run1Id}`);
    await completeSlackTriggeredRun({
      runId: run2Id,
      sandboxToken: claim2.sandboxToken,
      cliAgentType: "claude-code",
    });
    const run2 = await runs.readRun(actor, run2Id);
    expect(run2.result?.agentSessionId).toBe(session1);

    const switched = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId,
      }),
    );
    expect(switched).toBe("");
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: channelId,
        user: slackUserId,
        text: "Switched to *BDD Slack Switch Agent*.",
      }),
    );
    context.mocks.slack.chat.postMessage.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "run with my override",
      ts: "3000.000300",
      thread_ts: threadTs,
      channel: channelId,
    });
    const run3Id = await pollSlackRun(runnerGroup);
    const claim3 = await runs.claimRunnerJob(run3Id);
    expect(claim3.resumeSession).toBeNull();
    await completeSlackTriggeredRun({
      runId: run3Id,
      sandboxToken: claim3.sandboxToken,
      cliAgentType: "claude-code",
    });
    const run3 = await runs.readRun(actor, run3Id);
    expect(run3.result?.agentSessionId).not.toBe(session1);
    await waitForExpectation(() => {
      expect(slackPostMessageCallsJson()).toContain(
        "Responded by BDD Slack Switch Agent",
      );
    });

    await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "__org_default__",
        channelId,
      }),
    );
    await integrations.updateUserModelPreference(actor, "gpt-5.5");
    const gptThreadTs = "3100.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "use gpt for this",
      ts: gptThreadTs,
      channel: channelId,
    });
    const run4Id = await pollSlackRun(runnerGroup);
    const claim4 = await runs.claimRunnerJob(run4Id);
    expect(claim4.cliAgentType).toBe("codex");
    expect(claim4.environment).toMatchObject({
      OPENAI_API_KEY: expect.stringMatching(/.+/),
      OPENAI_MODEL: "gpt-5.5",
    });
    await completeSlackTriggeredRun({
      runId: run4Id,
      sandboxToken: claim4.sandboxToken,
      cliAgentType: "codex",
    });
    const run4 = await runs.readRun(actor, run4Id);
    const session4 = run4.result?.agentSessionId;
    if (!session4) {
      throw new Error("Expected GPT Slack run to expose its session");
    }

    await integrations.updateUserModelPreference(actor, "claude-sonnet-4-6");
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "back to claude",
      ts: "3100.000200",
      thread_ts: gptThreadTs,
      channel: channelId,
    });
    const run5Id = await pollSlackRun(runnerGroup);
    const claim5 = await runs.claimRunnerJob(run5Id);
    expect(claim5.cliAgentType).toBe("claude-code");
    expect(claim5.resumeSession).toBeNull();
    await completeSlackTriggeredRun({
      runId: run5Id,
      sandboxToken: claim5.sandboxToken,
      cliAgentType: "claude-code",
    });
    const run5 = await runs.readRun(actor, run5Id);
    expect(run5.result?.agentSessionId).not.toBe(session4);
  });

  it("prompts disconnected Slack users and filters non-actionable messages", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    const { teamId } = await integrations.installSlackWorkspace(actor);
    const slackUserId = uniqueSlackUserId();
    integrations.clearSlackCallHistory();

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "hello agent",
      ts: "2000.000100",
      channel: "C_BDD_LOGIN",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C_BDD_LOGIN",
          user: slackUserId,
        }),
      );
      expect(
        JSON.stringify(context.mocks.slack.chat.postEphemeral.mock.calls),
      ).toContain("connect your account");
    });

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "hello in dm",
      ts: "2000.000200",
      channel: "D_BDD_LOGIN",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_LOGIN",
          text: "Please connect your account first",
        }),
      );
    });

    context.mocks.slack.chat.postMessage.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "bot message",
      ts: "2000.000300",
      channel: "D_BDD_LOGIN",
      bot_id: "B_BDD",
    });
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "edited message",
      ts: "2000.000400",
      channel: "D_BDD_LOGIN",
      subtype: "message_changed",
    });
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "channel",
      user: slackUserId,
      text: "channel chatter",
      ts: "2000.000500",
      channel: "C_BDD_LOGIN",
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "file upload",
      ts: "2000.000600",
      channel: "D_BDD_LOGIN",
      subtype: "file_share",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
      expect(slackPostMessageCallsJson()).toContain(
        "Please connect your account first",
      );
    });

    const unbound = await integrations.installSlackWorkspace(null);
    context.mocks.slack.chat.postMessage.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();
    context.mocks.slack.assistant.threads.setStatus.mockClear();
    await integrations.postSlackEvent(
      `T_BDD_MISSING_${randomUUID().slice(0, 6)}`,
      {
        type: "app_mention",
        user: slackUserId,
        text: "hello nowhere",
        ts: "2000.000700",
        channel: "C_BDD_LOGIN",
      },
    );
    await integrations.postSlackEvent(unbound.teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "unbound dm",
      ts: "2000.000800",
      channel: "D_BDD_LOGIN",
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();
  });

  it("notifies connected Slack users when no usable org agent is configured", async () => {
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();

    const bare = bdd.user();
    const bareSlackUserId = uniqueSlackUserId();
    const bareInstall = await integrations.installSlackWorkspace(bare, {
      installerSlackUserId: bareSlackUserId,
    });
    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(bareInstall.teamId, {
      type: "app_mention",
      user: bareSlackUserId,
      text: "hello agent",
      ts: "2100.000100",
      channel: "C_BDD_NOAGENT",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C_BDD_NOAGENT",
          user: bareSlackUserId,
          text: expect.stringContaining("No agent is configured"),
        }),
      );
    });

    // Beyond the legacy baseline: a connected Slack user with zero visible
    // agents gets the no-agents ephemeral from /zero switch, and the App
    // Home switch action returns silently without opening a modal.
    const emptySwitch = await integrations.postSlackCommand({
      teamId: bareInstall.teamId,
      userId: bareSlackUserId,
      channelId: "C_BDD_NOAGENT",
      text: "switch",
      triggerId: "trigger-bdd-noagent-switch",
    });
    expect(JSON.stringify(emptySwitch)).toContain(
      "No agents are available to your Slack account.",
    );
    const silentHomeSwitch = await integrations.postSlackInteractive({
      type: "block_actions",
      user: {
        id: bareSlackUserId,
        username: "bdduser",
        team_id: bareInstall.teamId,
      },
      team: { id: bareInstall.teamId, domain: "bdd" },
      trigger_id: "trigger-bdd-noagent-home",
      actions: [{ action_id: "home_switch_agent", block_id: "home" }],
    });
    expect(silentHomeSwitch).toBe("");
    expect(context.mocks.slack.views.open).not.toHaveBeenCalled();

    // Deleting the org default agent clears orgMetadata.defaultAgentId at the
    // DB level (FK onDelete: "set null"), and the default-agent PUT validates
    // zeroAgents membership, so resolveEffectiveCompose's "not_found" status
    // ("configured agent could not be found" notice) is unreachable through
    // public APIs. The deleted-default journey lands on the "not_configured"
    // status's "No agent is configured" notice, delivered through the DM
    // postMessage branch here instead of the channel ephemeral. The
    // "not_accessible" status is covered by the hidden-private-default
    // journey in this describe.
    const onboarded = bdd.user();
    await bdd.setupOnboarding(onboarded, {
      displayName: "BDD Slack Deleted Agent",
    });
    const status = await bdd.readOnboardingStatus(onboarded);
    if (!status.defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    await bdd.deleteAgent(onboarded, status.defaultAgentId);
    const missingSlackUserId = uniqueSlackUserId();
    const missingInstall = await integrations.installSlackWorkspace(onboarded, {
      installerSlackUserId: missingSlackUserId,
    });
    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(missingInstall.teamId, {
      type: "message",
      channel_type: "im",
      user: missingSlackUserId,
      text: "hello in dm",
      ts: "2100.000200",
      channel: "D_BDD_MISSING_AGENT",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_MISSING_AGENT",
          text: expect.stringContaining("No agent is configured"),
        }),
      );
    });
  });

  it("serves Slack slash commands for help, connect, switch, model, and disconnect", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.setupOnboarding(actor, {
      displayName: "BDD Slack Default Agent",
    });
    const status = await bdd.readOnboardingStatus(actor);
    const defaultAgentId = status.defaultAgentId;
    if (!defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Picker Agent",
    });
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const ownPrivate = await bdd.createAgent(actor, {
      displayName: "BDD Slack Own Private",
      visibility: "private",
    });
    const memberPublic = await bdd.createAgent(member, {
      displayName: "BDD Slack Member Public",
    });
    const memberPrivate = await bdd.createAgent(member, {
      displayName: "BDD Slack Member Private",
      visibility: "private",
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    for (const text of ["", "help", "unknown"]) {
      const help = await integrations.postSlackCommand({
        teamId,
        userId: slackUserId,
        channelId: "C_BDD_CMD",
        text,
      });
      const helpJson = JSON.stringify(help);
      expect(helpJson).toContain("Zero Slack Bot Help");
      expect(helpJson).toContain("/zero switch");
      expect(helpJson).toContain("/zero model");
    }

    const alreadyConnected = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "connect",
    });
    expect(JSON.stringify(alreadyConnected)).toContain("already connected");

    const switchResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "switch",
      triggerId: "trigger-bdd-switch",
    });
    expect(switchResponse).toBe("");
    const switchModal = latestSlackModal();
    expect(switchModal.triggerId).toBe("trigger-bdd-switch");
    expect(switchModal.callbackId).toBe("switch_agent_modal");
    expect(switchModal.privateMetadata).toBe(
      JSON.stringify({ channelId: "C_BDD_CMD" }),
    );
    expect(switchModal.optionValues).toContain("__org_default__");
    expect(switchModal.optionValues).toContain(agentB.agentId);
    expect(switchModal.optionValues).toContain(ownPrivate.agentId);
    expect(switchModal.optionValues).toContain(memberPublic.agentId);
    expect(switchModal.optionValues).not.toContain(defaultAgentId);
    expect(switchModal.optionValues).not.toContain(memberPrivate.agentId);
    expect(switchModal.optionLabels).toContainEqual(
      expect.stringContaining("Use org default"),
    );

    await integrations.updateUserModelPreference(actor, "gpt-5.5");
    const modelResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "model",
      triggerId: "trigger-bdd-model",
    });
    expect(modelResponse).toBe("");
    const modelModal = latestSlackModal();
    expect(modelModal.triggerId).toBe("trigger-bdd-model");
    expect(modelModal.callbackId).toBe("model_preference_modal");
    expect(modelModal.privateMetadata).toBe(
      JSON.stringify({ channelId: "C_BDD_CMD" }),
    );
    expect(modelModal.optionLabels).toContainEqual(
      expect.stringContaining("(workspace default)"),
    );
    expect(modelModal.initialOptionValue).toBe("gpt-5.5");

    const disconnected = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "disconnect",
    });
    expect(JSON.stringify(disconnected)).toContain("disconnected");
    expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: slackUserId }),
    );
    const connectStatus = await integrations.requestSlackConnectStatus(
      actor,
      [200],
    );
    expect(connectStatus.body).toMatchObject({ isConnected: false });

    const notConnected = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "disconnect",
    });
    expect(JSON.stringify(notConnected)).toContain("not connected");

    const loginPrompt = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_CMD",
      text: "connect",
    });
    expect(JSON.stringify(loginPrompt)).toContain(
      "https://app.vm0.test/settings/slack",
    );
  });

  it("handles Slack commands for unknown workspaces and unbound installations", async () => {
    integrations.configureSlackAppMocks();
    const slackUserId = uniqueSlackUserId();

    const notInstalled = await integrations.postSlackCommand({
      teamId: `T_BDD_NONE_${randomUUID().slice(0, 8)}`,
      userId: slackUserId,
      text: "connect",
    });
    expect(JSON.stringify(notInstalled)).toContain("hasn't been set up");

    const unbound = await integrations.installSlackWorkspace(null);
    const help = await integrations.postSlackCommand({
      teamId: unbound.teamId,
      userId: slackUserId,
      text: "help",
    });
    const helpJson = JSON.stringify(help);
    expect(helpJson).toContain("/zero connect");
    expect(helpJson).not.toContain("/zero switch");
    expect(helpJson).not.toContain("/zero model");
  });

  it("prompts for login when switching agents without a Slack connection", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.setupOnboarding(actor, {
      displayName: "BDD Slack Login Agent",
    });
    const { teamId } = await integrations.installSlackWorkspace(actor);
    integrations.clearSlackCallHistory();

    const disconnectedUserId = uniqueSlackUserId();
    const response = await integrations.postSlackCommand({
      teamId,
      userId: disconnectedUserId,
      channelId: "C_BDD_CMD",
      text: "switch",
    });
    const responseJson = JSON.stringify(response);
    expect(responseJson).toContain("ephemeral");
    expect(responseJson).toContain("connect");
    expect(context.mocks.slack.views.open).not.toHaveBeenCalled();
  });

  it("persists Slack agent and model picker selections through interactive submissions", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();

    const missingSelection = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: "T_BDD_NONE",
        slackUserId: "U_BDD_NONE",
        selectedValue: "",
      }),
    );
    expect(missingSelection).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "Please choose an agent." },
    });

    await bdd.setupOnboarding(actor, {
      displayName: "BDD Slack Picker Default",
    });
    const status = await bdd.readOnboardingStatus(actor);
    if (!status.defaultAgentId) {
      throw new Error("Expected onboarding to configure a default agent");
    }
    const defaultAgent = await bdd.readAgent(actor, status.defaultAgentId);
    if (!defaultAgent.displayName) {
      throw new Error("Expected onboarding default agent display name");
    }
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Picker Override",
    });
    const outsider = bdd.user();
    const outsiderAgent = await bdd.createAgent(outsider, {
      displayName: "BDD Slack Foreign Agent",
    });
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const ownPrivate = await bdd.createAgent(actor, {
      displayName: "BDD Slack Picker Own Private",
      visibility: "private",
    });
    const memberPublic = await bdd.createAgent(member, {
      displayName: "BDD Slack Picker Member Public",
    });
    const memberPrivate = await bdd.createAgent(member, {
      displayName: "BDD Slack Picker Member Private",
      visibility: "private",
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const selectB = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId: "C_BDD_PICK",
      }),
    );
    expect(selectB).toBe("");
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_BDD_PICK",
        user: slackUserId,
        text: "Switched to *BDD Slack Picker Override*.",
      }),
    );
    await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_PICK",
      text: "switch",
    });
    expect(latestSlackModal().initialOptionValue).toBe(agentB.agentId);

    const foreign = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: outsiderAgent.agentId,
      }),
    );
    expect(foreign).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "You don't have access to that agent." },
    });

    const sameOrgPrivate = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: memberPrivate.agentId,
      }),
    );
    expect(sameOrgPrivate).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "You don't have access to that agent." },
    });

    context.mocks.slack.chat.postEphemeral.mockRejectedValueOnce(
      new Error("ephemeral delivery failed"),
    );
    const confirmFailure = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId: "C_BDD_PICK",
      }),
    );
    expect(confirmFailure).toBe("");
    await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_PICK",
      text: "switch",
    });
    expect(latestSlackModal().initialOptionValue).toBe(agentB.agentId);

    const restoreDefault = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "__org_default__",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(restoreDefault).toBe("");
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_BDD_PICK",
        user: slackUserId,
        text: `Switched to *${defaultAgent.displayName}*.`,
      }),
    );

    const selectModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "claude-sonnet-4-6",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(selectModel).toBe("");
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "claude-sonnet-4-6",
    });

    const replaceModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "gpt-5.5",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(replaceModel).toBe("");
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "gpt-5.5",
    });

    const rejectedModel = await integrations.postSlackInteractive(
      integrations.modelPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "model-outside-policy",
        channelId: "C_BDD_PICK",
      }),
    );
    expect(rejectedModel).toStrictEqual({
      response_action: "errors",
      errors: { model_select_block: "You don't have access to that model." },
    });
    await expect(
      integrations.readUserModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "gpt-5.5",
    });

    context.mocks.slack.views.open.mockClear();
    const homeSwitch = await integrations.postSlackInteractive({
      type: "block_actions",
      user: { id: slackUserId, username: "bdduser", team_id: teamId },
      team: { id: teamId, domain: "bdd" },
      trigger_id: "trigger-bdd-home",
      actions: [{ action_id: "home_switch_agent", block_id: "home" }],
    });
    expect(homeSwitch).toBe("");
    const homeModal = latestSlackModal();
    expect(homeModal.callbackId).toBe("switch_agent_modal");
    expect(homeModal.privateMetadata).toBeNull();
    expect(homeModal.optionValues).toContain("__org_default__");
    expect(homeModal.optionValues).toContain(agentB.agentId);
    expect(homeModal.optionValues).toContain(ownPrivate.agentId);
    expect(homeModal.optionValues).toContain(memberPublic.agentId);
    expect(homeModal.optionValues).not.toContain(status.defaultAgentId);
    expect(homeModal.optionValues).not.toContain(memberPrivate.agentId);
  });

  it("hides an inaccessible private org default across pickers, App Home, and runs", async () => {
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    const actor = bdd.user();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const hiddenDefault = await bdd.createAgent(member, {
      displayName: "BDD Hidden Default",
      visibility: "private",
    });
    const visiblePublic = await bdd.createAgent(member, {
      displayName: "BDD Visible Public",
    });
    await integrations.setDefaultAgent(actor, hiddenDefault.agentId);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const switchResponse = await integrations.postSlackCommand({
      teamId,
      userId: slackUserId,
      channelId: "C_BDD_HIDDEN",
      text: "switch",
      triggerId: "trigger-bdd-hidden-switch",
    });
    expect(switchResponse).toBe("");
    const commandModal = latestSlackModal();
    expect(commandModal.optionValues).not.toContain("__org_default__");
    expect(commandModal.optionValues).toContain(visiblePublic.agentId);
    expect(commandModal.optionValues).not.toContain(hiddenDefault.agentId);
    expect(commandModal.optionLabels).not.toContainEqual(
      expect.stringContaining("Use org default"),
    );

    const orgDefaultRejected = await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: "__org_default__",
      }),
    );
    expect(orgDefaultRejected).toStrictEqual({
      response_action: "errors",
      errors: { agent_select_block: "You don't have access to that agent." },
    });

    context.mocks.slack.views.open.mockClear();
    const homeSwitch = await integrations.postSlackInteractive({
      type: "block_actions",
      user: { id: slackUserId, username: "bdduser", team_id: teamId },
      team: { id: teamId, domain: "bdd" },
      trigger_id: "trigger-bdd-hidden-home",
      actions: [{ action_id: "home_switch_agent", block_id: "home" }],
    });
    expect(homeSwitch).toBe("");
    const homeModal = latestSlackModal();
    expect(homeModal.optionValues).not.toContain("__org_default__");
    expect(homeModal.optionValues).toContain(visiblePublic.agentId);
    expect(homeModal.optionValues).not.toContain(hiddenDefault.agentId);

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "hello in dm",
      ts: "2200.000100",
      channel: "D_BDD_HIDDEN",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_HIDDEN",
          text: expect.stringContaining("not available to your Slack account"),
        }),
      );
    });
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();

    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "home",
      channel: "D_BDD_HIDDEN_HOME",
    });
    await waitForExpectation(() => {
      expect(
        JSON.stringify(context.mocks.slack.views.publish.mock.calls),
      ).toContain("_No agent configured yet._");
    });
    const homeViewJson = JSON.stringify(
      context.mocks.slack.views.publish.mock.calls.at(-1),
    );
    expect(homeViewJson).toContain("home_switch_agent");
    expect(homeViewJson).toContain("_No agent configured yet._");
  });

  it("refreshes Slack App Home, welcomes once, and cleans up lifecycle events", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.setupOnboarding(actor, {
      displayName: "BDD Slack Home Agent",
    });
    const slackUserId = uniqueSlackUserId();
    const install = await integrations.installSlackWorkspace(null);
    await integrations.connectSlackUser(actor, {
      workspaceId: install.teamId,
      slackUserId,
      channelId: "C_BDD_HOME",
    });
    integrations.clearSlackCallHistory();
    const teamId = install.teamId;

    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "home",
      channel: "D_BDD_HOME",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: slackUserId }),
      );
      expect(
        JSON.stringify(context.mocks.slack.views.publish.mock.calls),
      ).toContain("Connected to Zero");
    });

    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "messages",
      channel: "D_BDD_HOME",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "D_BDD_HOME" }),
      );
    });
    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "messages",
      channel: "D_BDD_HOME",
    });
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();

    context.mocks.slack.views.publish.mockClear();
    const homeDisconnect = {
      type: "block_actions",
      user: { id: slackUserId, username: "bdduser", team_id: teamId },
      team: { id: teamId, domain: "bdd" },
      actions: [{ action_id: "home_disconnect", block_id: "home" }],
    };
    const disconnected =
      await integrations.postSlackInteractive(homeDisconnect);
    expect(disconnected).toBe("");
    expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();
    const disconnectedStatus = await integrations.requestSlackConnectStatus(
      actor,
      [200],
    );
    expect(disconnectedStatus.body).toMatchObject({ isConnected: false });

    const repeatDisconnect =
      await integrations.postSlackInteractive(homeDisconnect);
    expect(repeatDisconnect).toBe("");
    expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();

    context.mocks.slack.views.publish.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "home",
      channel: "D_BDD_HOME",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();
      expect(
        JSON.stringify(context.mocks.slack.views.publish.mock.calls),
      ).toContain("Account not connected");
    });
    await integrations.postSlackEvent(teamId, {
      type: "app_home_opened",
      user: slackUserId,
      tab: "messages",
      channel: "D_BDD_HOME",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
    });

    context.mocks.slack.views.publish.mockClear();
    await integrations.postSlackEvent(
      `T_BDD_NOWHERE_${randomUUID().slice(0, 6)}`,
      {
        type: "app_home_opened",
        user: slackUserId,
        tab: "home",
        channel: "D_BDD_HOME",
      },
    );
    expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();

    await integrations.postSlackEvent(teamId, { type: "app_uninstalled" });
    await expect
      .poll(async () => {
        const status = await integrations.requestSlackIntegrationStatus(
          actor,
          [200],
        );
        return "isInstalled" in status.body ? status.body.isInstalled : null;
      })
      .toBe(false);
    const orgStatus = await integrations.requestSlackIntegrationStatus(
      actor,
      [200],
    );
    expect(orgStatus.body).toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
    const stateAfterUninstall = await integrations.readSlackTestState(teamId);
    expect(stateAfterUninstall.installation).toBeNull();
    expect(stateAfterUninstall.connections).toHaveLength(0);

    const unbound = await integrations.installSlackWorkspace(null);
    await integrations.postSlackEvent(unbound.teamId, {
      type: "app_uninstalled",
    });
    await expect
      .poll(async () => {
        const state = await integrations.readSlackTestState(unbound.teamId);
        return state.installation;
      })
      .toBeNull();
    const unboundState = await integrations.readSlackTestState(unbound.teamId);
    expect(unboundState.installation).toBeNull();

    const revoked = await integrations.installSlackWorkspace(null);
    await integrations.connectSlackUser(actor, {
      workspaceId: revoked.teamId,
      slackUserId,
      channelId: "C_BDD_HOME",
    });
    await integrations.postSlackEvent(revoked.teamId, {
      type: "tokens_revoked",
      tokens: { bot: ["xoxb-revoked"] },
    });
    await expect
      .poll(async () => {
        const state = await integrations.readSlackTestState(revoked.teamId);
        return state.installation;
      })
      .toBeNull();
    const revokedState = await integrations.readSlackTestState(revoked.teamId);
    expect(revokedState.installation).toBeNull();
    expect(revokedState.connections).toHaveLength(0);
  });

  it("replies with run-creation errors for Slack messages before dispatch", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await bdd.setupOnboarding(actor, {
      displayName: "BDD Slack Failing Default",
    });
    await integrations.configureSlackRunModelPolicies(actor);
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD Slack Failing Override",
    });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "please run something",
      ts: "5000.000100",
      channel: "D_BDD_FAIL",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D_BDD_FAIL",
          thread_ts: "5000.000100",
          text: expect.stringContaining("Add credits"),
        }),
      );
    });
    expect(slackPostMessageCallsJson()).not.toContain("Sent via");
    await waitForExpectation(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: "D_BDD_FAIL",
          status: "is thinking...",
        }),
      );
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ channel_id: "D_BDD_FAIL", status: "" }),
      );
    });

    await integrations.postSlackInteractive(
      integrations.agentPickerSubmission({
        workspaceId: teamId,
        slackUserId,
        selectedValue: agentB.agentId,
        channelId: "D_BDD_FAIL",
      }),
    );
    context.mocks.slack.chat.postMessage.mockClear();
    await integrations.postSlackEvent(teamId, {
      type: "message",
      channel_type: "im",
      user: slackUserId,
      text: "run with my override",
      ts: "5000.000200",
      channel: "D_BDD_FAIL",
    });
    await waitForExpectation(() => {
      expect(slackPostMessageCallsJson()).toContain(
        "Sent via BDD Slack Failing Override",
      );
    });
  });

  it("delivers Slack org callbacks for progress, audit footers, failures, and Slack errors", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const callbackLog = integrations.forwardSlackInternalCallbacks();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await integrations.configureSlackRunModelPolicies(actor);
    await bdd.readOnboardingStatus(actor);
    await integrations.enableAuditLinkSwitch(actor);
    const slackUser1 = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUser1,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_ORG_CB";
    const threadT1 = "4000.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "summarize the audited thread",
      ts: threadT1,
      channel: channelId,
    });
    const run1Id = await pollSlackRun(runnerGroup);
    const claim1 = await runs.claimRunnerJob(run1Id);
    context.mocks.slack.assistant.threads.setStatus.mockClear();
    await webhooks.requestAgentHeartbeat(
      { runId: run1Id },
      { authorization: `Bearer ${claim1.sandboxToken}` },
      [200],
    );
    await waitForExpectation(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenCalledWith({
        channel_id: channelId,
        thread_ts: threadT1,
        status: "is thinking...",
      });
    });
    await waitForSlackOrgCallback(callbackLog, {
      path: "/api/internal/callbacks/slack/org",
      status: 200,
      body: { success: true },
    });

    integrations.mockSlackRunResultOutput("SLACK_BDD_OUTPUT");
    await completeSlackTriggeredRun({
      runId: run1Id,
      sandboxToken: claim1.sandboxToken,
      cliAgentType: "claude-code",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: channelId,
          thread_ts: threadT1,
          text: "SLACK_BDD_OUTPUT",
        }),
      );
    });
    const auditedBlocks = slackPostMessageCallsJson();
    expect(auditedBlocks).toContain("Audit");
    expect(auditedBlocks).toContain(
      `https://app.vm0.test/activities/${run1Id}`,
    );
    expect(auditedBlocks).toContain("Claude Sonnet 4.6");
    await waitForExpectation(() => {
      expect(
        context.mocks.slack.assistant.threads.setStatus,
      ).toHaveBeenLastCalledWith({
        channel_id: channelId,
        thread_ts: threadT1,
        status: "",
      });
    });
    const run1 = await runs.readRun(actor, run1Id);
    expect(run1.status).toBe("completed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "answer through codex items",
      ts: "4000.000200",
      channel: channelId,
    });
    const run2Id = await pollSlackRun(runnerGroup);
    const claim2 = await runs.claimRunnerJob(run2Id);
    integrations.mockSlackRunAgentMessageOutput("final codex answer");
    await completeSlackTriggeredRun({
      runId: run2Id,
      sandboxToken: claim2.sandboxToken,
      cliAgentType: "claude-code",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "final codex answer" }),
      );
    });

    if (!actor.orgId) {
      throw new Error("Expected the Slack chain actor to have an org");
    }
    const actor2 = integrations.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    const slackUser2 = uniqueSlackUserId();
    await integrations.connectSlackUser(actor2, {
      workspaceId: teamId,
      slackUserId: slackUser2,
    });
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser2,
      text: "second opinion in the same thread",
      ts: "4000.000150",
      thread_ts: threadT1,
      channel: channelId,
    });
    const run3Id = await pollSlackRun(runnerGroup);
    const claim3 = await runs.claimRunnerJob(run3Id);
    context.mocks.slack.chat.postMessage.mockClear();
    await completeSlackTriggeredRun({
      runId: run3Id,
      sandboxToken: claim3.sandboxToken,
      cliAgentType: "claude-code",
    });
    await waitForExpectation(() => {
      expect(slackPostMessageCallsJson()).toContain(
        `Reply to <@${slackUser2}>`,
      );
    });
    const run3 = await runs.readRun(actor2, run3Id);
    expect(run3.status).toBe("completed");

    const threadT3 = "4000.000300";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "resume a broken checkpoint",
      ts: threadT3,
      channel: channelId,
    });
    const run4Id = await pollSlackRun(runnerGroup);
    const claim4 = await runs.claimRunnerJob(run4Id);
    await webhooks.requestAgentComplete(
      {
        runId: run4Id,
        exitCode: 1,
        error: "Cannot continue session from checkpoint",
      },
      { authorization: `Bearer ${claim4.sandboxToken}` },
      [200],
    );
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "Cannot continue session from checkpoint",
        }),
      );
    });
    await waitForSlackOrgCallback(callbackLog, {
      path: "/api/internal/callbacks/slack/org",
      status: 200,
      body: { success: true },
    });
    const run4 = await runs.readRun(actor, run4Id);
    expect(run4.status).toBe("failed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "try the broken thing again",
      ts: "4000.000310",
      thread_ts: threadT3,
      channel: channelId,
    });
    const run5Id = await pollSlackRun(runnerGroup);
    const claim5 = await runs.claimRunnerJob(run5Id);
    await webhooks.requestAgentComplete(
      { runId: run5Id, exitCode: 1 },
      { authorization: `Bearer ${claim5.sandboxToken}` },
      [200],
    );
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "Oops, something went wrong. Please try again later.",
        }),
      );
    });
    const run5 = await runs.readRun(actor, run5Id);
    expect(run5.status).toBe("failed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUser1,
      text: "post into a vanished channel",
      ts: "4000.000400",
      channel: channelId,
    });
    const run6Id = await pollSlackRun(runnerGroup);
    const claim6 = await runs.claimRunnerJob(run6Id);
    integrations.mockSlackRunResultOutput("UNDELIVERED_OUTPUT");
    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );
    await completeSlackTriggeredRun({
      runId: run6Id,
      sandboxToken: claim6.sandboxToken,
      cliAgentType: "claude-code",
    });
    await waitForSlackOrgCallback(callbackLog, {
      path: "/api/internal/callbacks/slack/org",
      status: 400,
      body: { error: "Slack API error: channel_not_found" },
    });
    const run6 = await runs.readRun(actor, run6Id);
    expect(run6.status).toBe("completed");
  }, 90_000);

  it("keeps Slack org callbacks visible when model routes unpin and installs vanish", async () => {
    const actor = bdd.user();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    integrations.configureSlackAppMocks();
    integrations.acceptSlackSessionHistoryDownloads();
    const callbackLog = integrations.forwardSlackInternalCallbacks();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await bdd.readOnboardingStatus(actor);
    await integrations.configureUnpinnedSlackModelRoute(actor);
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    integrations.clearSlackCallHistory();

    const channelId = "C_BDD_UNPINNED";
    const threadU1 = "5100.000100";
    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "run without a pinned model",
      ts: threadU1,
      channel: channelId,
    });
    const run1Id = await pollSlackRun(runnerGroup);
    const claim1 = await runs.claimRunnerJob(run1Id);
    expect(claim1.cliAgentType).toBe("claude-code");
    expect(claim1.environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: expect.stringMatching(/.+/),
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    });

    context.mocks.slack.assistant.threads.setStatus.mockRejectedValueOnce(
      new Error("status_boom"),
    );
    await webhooks.requestAgentHeartbeat(
      { runId: run1Id },
      { authorization: `Bearer ${claim1.sandboxToken}` },
      [200],
    );
    await waitForSlackOrgCallback(callbackLog, {
      path: "/api/internal/callbacks/slack/org",
      status: 200,
      body: { success: true },
    });

    integrations.mockSlackRunResultOutput("NO_MODEL_FOOTER_OUTPUT");
    await completeSlackTriggeredRun({
      runId: run1Id,
      sandboxToken: claim1.sandboxToken,
      cliAgentType: "claude-code",
    });
    await waitForExpectation(() => {
      expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: channelId,
          thread_ts: threadU1,
          text: "NO_MODEL_FOOTER_OUTPUT",
        }),
      );
    });
    const unpinnedBlocks = slackPostMessageCallsJson();
    expect(unpinnedBlocks).not.toContain("Audit");
    expect(unpinnedBlocks).not.toContain("Responded by");
    expect(unpinnedBlocks).not.toContain("Reply to");
    expect(unpinnedBlocks).not.toContain("Claude");
    const run1 = await runs.readRun(actor, run1Id);
    expect(run1.status).toBe("completed");

    await integrations.postSlackEvent(teamId, {
      type: "app_mention",
      user: slackUserId,
      text: "survive the uninstall",
      ts: "5100.000200",
      channel: channelId,
    });
    const run2Id = await pollSlackRun(runnerGroup);
    const claim2 = await runs.claimRunnerJob(run2Id);
    await integrations.postSlackEvent(teamId, { type: "app_uninstalled" });
    context.mocks.slack.assistant.threads.setStatus.mockClear();
    await webhooks.requestAgentHeartbeat(
      { runId: run2Id },
      { authorization: `Bearer ${claim2.sandboxToken}` },
      [200],
    );
    await waitForSlackOrgCallback(callbackLog, {
      path: "/api/internal/callbacks/slack/org",
      status: 200,
      body: { success: true },
    });
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();

    context.mocks.slack.chat.postMessage.mockClear();
    await completeSlackTriggeredRun({
      runId: run2Id,
      sandboxToken: claim2.sandboxToken,
      cliAgentType: "claude-code",
    });
    await waitForSlackOrgCallback(callbackLog, {
      path: "/api/internal/callbacks/slack/org",
      status: 404,
      body: { error: "Slack installation not found" },
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    const run2 = await runs.readRun(actor, run2Id);
    expect(run2.status).toBe("completed");
  }, 90_000);
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

  it("refreshes telegram typing for pending webhook-dispatched runs", async () => {
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    const actor = integrations.user();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Telegram typing agent",
    });

    const typingBotId = randomInt(1_000_000_000, 9_999_999_999);
    const typingBotToken = `${typingBotId}:bdd-typing-token`;
    const botId = String(typingBotId);
    const chatActions: {
      readonly chat_id: string;
      readonly action: string;
    }[] = [];
    server.use(
      telegramDomainProbe(),
      http.post(
        `https://api.telegram.org/bot${typingBotToken}/sendChatAction`,
        async ({ request }) => {
          chatActions.push(
            (await request.json()) as (typeof chatActions)[number],
          );
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
      http.post(
        `https://api.telegram.org/bot${typingBotToken}/sendMessage`,
        () => {
          return HttpResponse.json({
            ok: true,
            result: { message_id: 654, chat: { id: 999_111 } },
          });
        },
      ),
    );
    // Terminal dispatch of the run's Telegram callback settles its row
    // (capture answers 500) instead of hitting an unhandled MSW route.
    webhooks.captureInternalCallbackDeliveries(
      "/api/internal/callbacks/telegram",
    );

    context.mocks.telegram.getMe.mockResolvedValue({
      id: typingBotId,
      username: "bdd_typing_bot",
      can_read_all_group_messages: true,
    });
    let webhookSecret: string | undefined;
    context.mocks.telegram.setWebhook.mockImplementation(
      (...args: readonly unknown[]) => {
        const secret = args[2];
        if (typeof secret === "string") {
          webhookSecret = secret;
        }
        return Promise.resolve();
      },
    );
    await integrations.requestRegisterTelegramBot(
      actor,
      { botToken: typingBotToken, defaultAgentId: agent.agentId },
      [201],
    );
    if (!webhookSecret) {
      throw new Error(
        "Expected Telegram registration to configure a webhook secret",
      );
    }

    // Link the actor with a valid Telegram login hash — the test knows the
    // bot token because it registered the bot through the API.
    const telegramUserId = randomInt(100_000_000, 999_999_999);
    await integrations.requestLinkTelegram(
      actor,
      {
        telegramBotId: botId,
        telegramAuth: telegramLoginAuth(typingBotToken, {
          id: telegramUserId,
          first_name: "BDD",
          username: "bdd_typing_user",
        }),
      },
      [200],
    );
    const linkStatus = await integrations.readTelegramLinkStatus(actor, botId);
    expect(linkStatus).toMatchObject({ linked: true });

    // A linked DM dispatches a run carrying a pending Telegram callback.
    const dmChatId = 8_811_223;
    const dm = await integrations.requestTelegramWebhook(
      botId,
      JSON.stringify({
        update_id: 4001,
        message: {
          message_id: 71,
          chat: { id: dmChatId, type: "private" },
          from: {
            id: telegramUserId,
            first_name: "BDD",
            username: "bdd_typing_user",
          },
          text: "summarize my telegram inbox",
        },
      }),
      { "x-telegram-bot-api-secret-token": webhookSecret },
      [200],
    );
    expect(dm.body).toBe("OK");

    // Poll only: claiming is not needed and the callback must stay pending.
    const runId = await pollRunnerRun(
      runnerGroup,
      "Expected the Telegram DM to dispatch a run",
    );
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }

    const typingBody = {
      runId,
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId: actor.userId, orgId: actor.orgId },
    };
    const actionsBeforeTyping = chatActions.length;
    const typing = await integrations.requestTelegramTypingEventConsumer(
      typingBody,
      webhooks.signedEventConsumerHeaders(typingBody),
      [200],
    );
    expect(typing.body).toStrictEqual({ scheduled: true });
    await waitForExpectation(() => {
      expect(chatActions.slice(actionsBeforeTyping)).toStrictEqual([
        { chat_id: String(dmChatId), action: "typing" },
      ]);
    });

    // Once the run is cancelled no Telegram callback stays pending, so a
    // second typing refresh sends nothing.
    await runs.requestCancelRun(actor, runId, [200]);
    await expect
      .poll(async () => {
        const run = await runs.readRun(actor, runId);
        return run.status;
      })
      .toBe("cancelled");
    const actionsAfterCancel = chatActions.length;
    const idleTyping = await integrations.requestTelegramTypingEventConsumer(
      typingBody,
      webhooks.signedEventConsumerHeaders(typingBody),
      [200],
    );
    expect(idleTyping.body).toStrictEqual({ scheduled: true });
    expect(chatActions).toHaveLength(actionsAfterCancel);
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
