import { createHash, randomUUID } from "node:crypto";

import { WebClient } from "@slack/web-api";
import {
  runnersHeartbeatContract,
  runnersJobClaimContract,
} from "@vm0/api-contracts/contracts/runners";
import type { TestSlackDispatchProbeResponse } from "@vm0/api-contracts/contracts/test-slack-dispatch-probe";
import type {
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { verifyZeroToken } from "../../auth/tokens";
import { runnersRoutes } from "../runners";
import { testSlackDispatchProbeRoutes } from "../test-slack-dispatch-probe";
import { testSlackStateRoutes } from "../test-slack-state";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const computerUseApi = createComputerUseBddApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const ROUTE = "/api/test/slack-dispatch-probe";
const SLACK_STATE_ROUTE = "/api/test/slack-state";
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

interface SlackProbeFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
  readonly slackUserId: string;
  readonly defaultAgentId: string | null;
  readonly connectionId: string | null;
}

function configureSlackProbeTest(): void {
  mockEnv("ENV", "development");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
  mockEnv("APP_URL", "https://app.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.slack.assistant.threads.setStatus.mockResolvedValue({
    ok: true,
  });
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "1710000000.000000",
    channel: "C-test",
  });
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "1710000000.000001",
  });
  context.mocks.slack.conversations.history.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.conversations.replies.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      profile: {
        display_name: "Slack User",
        email: "slack@example.com",
      },
      tz: "UTC",
    },
  });
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testSlackDispatchProbeRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

function requestSlackState(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testSlackStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

function postProbe(body: unknown): Promise<Response> {
  return requestApp(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postSlackState(body: unknown): Promise<Response> {
  return requestSlackState(SLACK_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockTestUserMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ createdAt: 10, organization: { id: orgId } }],
  });
}

async function seedSlackProbeFixture(
  options: {
    readonly withConnection?: boolean;
    readonly withDefaultAgent?: boolean;
  } = {},
): Promise<SlackProbeFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const orgId = `org_slack_probe_${suffix}`;
  const userId = `user_slack_probe_${suffix}`;
  const slackWorkspaceId = `T${suffix}`;
  const slackUserId = `U${suffix}`;
  mockTestUserMembership(userId, orgId);

  const response = await postSlackState({
    team_id: slackWorkspaceId,
    slack_user_id: slackUserId,
    workspace_name: "Slack Dispatch Probe",
    seed_connection: options.withConnection ?? false,
    seed_default_agent: options.withDefaultAgent ?? false,
    email: `${userId}@example.test`,
  });
  const body = await readJson<TestSlackStatePostResponse>(response);
  if (response.status !== 200) {
    throw new Error(
      `Expected Slack state seed to succeed, received ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }

  return {
    orgId: body.org_id,
    userId: body.vm0_user_id,
    slackWorkspaceId: body.team_id,
    slackUserId,
    defaultAgentId: body.default_agent_id,
    connectionId: body.connection_id,
  };
}

async function deleteSlackProbeFixture(
  fixture: SlackProbeFixture,
): Promise<void> {
  mockEnv("ENV", "development");
  await requestSlackState(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(
      fixture.slackWorkspaceId,
    )}`,
    { method: "DELETE" },
  );
}

function actorForFixture(fixture: SlackProbeFixture): ApiTestUser {
  return {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: `${fixture.userId}@example.test`,
  };
}

async function enableComputerUseDelegatedAuthorization(
  fixture: SlackProbeFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    },
    {
      [FeatureSwitchKey.ComputerUseDelegatedAuthorization]: true,
    },
  );
  mockTestUserMembership(fixture.userId, fixture.orgId);
}

async function heartbeatRunner() {
  return await accept(
    setupAppWithRoutes({ context, routes: runnersRoutes })(
      runnersHeartbeatContract,
    ).heartbeat({
      headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
      body: {
        runnerId: randomUUID(),
        runnerName: "slack-dispatch-probe-runner",
        group: "vm0/test",
        profiles: ["vm0/default"],
        totalVcpu: 8,
        totalMemoryMb: 16_384,
        maxConcurrent: 2,
        allocatedVcpu: 0,
        allocatedMemoryMb: 0,
        runningCount: 0,
        heldSessionStates: [],
        mode: "running",
      },
    }),
    [200],
  );
}

async function claimRunnerJob(runId: string) {
  const response = await accept(
    setupAppWithRoutes({ context, routes: runnersRoutes })(
      runnersJobClaimContract,
    ).claim({
      headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
      params: { id: runId },
      body: {},
    }),
    [200],
  );
  return response.body;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readSlackState(
  fixture: SlackProbeFixture,
): Promise<TestSlackStateResponse> {
  const response = await requestSlackState(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(
      fixture.slackWorkspaceId,
    )}`,
  );
  if (response.status !== 200) {
    throw new Error(`Expected Slack state read to succeed: ${response.status}`);
  }
  return await readJson<TestSlackStateResponse>(response);
}

async function claimSlackRunnerJob(
  fixture: SlackProbeFixture,
  expectedPrompt: string,
) {
  await heartbeatRunner();
  const state = await readSlackState(fixture);
  const run = state.recent_runs.find((recentRun) => {
    return (
      recentRun.triggerSource === "slack" &&
      recentRun.promptPreview === expectedPrompt
    );
  });
  if (!run) {
    throw new Error(
      `Expected Slack dispatch probe to enqueue prompt ${JSON.stringify(
        expectedPrompt,
      )}: ${JSON.stringify(state.recent_runs)}`,
    );
  }
  return await claimRunnerJob(run.id);
}

async function completeClaimedRun(
  runId: string,
  sandboxToken: string,
): Promise<void> {
  const headers = { authorization: `Bearer ${sandboxToken}` };
  await webhooksApi.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `slack-probe-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`slack dispatch probe ${runId}`)
        .digest("hex"),
    },
    headers,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    {
      runId,
      exitCode: 0,
    },
    headers,
    [200],
  );
}

function requestTokenFromUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  const prefix = "/computer-use/authorize/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`Unexpected authorization URL: ${authorizationUrl}`);
  }
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

describe("POST /api/test/slack-dispatch-probe", () => {
  const track = createFixtureTracker(deleteSlackProbeFixture);

  beforeEach(() => {
    configureSlackProbeTest();
  });

  it("hides the test endpoint outside allowed environments", async () => {
    mockEnv("ENV", "production");

    const response = await postProbe({});

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("allows Vercel preview runtimes with the internal bypass header", async () => {
    mockEnv("ENV", "production");
    mockOptionalEnv("VERCEL_ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const response = await requestApp(ROUTE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("allows preview with the schema-backed bypass secret", async () => {
    mockEnv("ENV", "preview");
    mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const response = await requestApp(ROUTE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("allows protected preview rewrites after Vercel consumes bypass headers", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const response = await postProbe({});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("routes preview Slack Web API calls to API mock routes", async () => {
    mockOptionalEnv("E2E_SLACK_MOCK_ENABLED", "1");
    mockOptionalEnv("VERCEL_URL", "pr-13948-api.vm6.ai");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const fixture = await track(
      seedSlackProbeFixture({ withConnection: true, withDefaultAgent: true }),
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: fixture.slackUserId,
      message_text: "mock Slack API",
      message_ts: "1710000003.000000",
    });

    expect(response.status).toBe(200);
    expect(WebClient).toHaveBeenCalledWith(expect.any(String), {
      slackApiUrl: "https://pr-13948-api.vm6.ai/api/test/slack-mock/",
      headers: {
        "x-vercel-protection-bypass": "preview-secret",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      retryConfig: { retries: 1 },
      timeout: 5000,
    });
  });

  it("returns the legacy missing-field error", async () => {
    const response = await postProbe({
      team_id: "T-test",
      channel_id: "C-test",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("synchronously dispatches connected mention probes", async () => {
    const fixture = await track(
      seedSlackProbeFixture({ withConnection: true, withDefaultAgent: true }),
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: fixture.slackUserId,
      message_text: "summarize this channel",
      message_ts: "1710000000.000000",
      channel_type: "channel",
    });

    expect(response.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(response),
    ).resolves.toStrictEqual({ ok: true });

    const claim = await claimSlackRunnerJob(fixture, "summarize this channel");
    expect(claim.prompt).toBe("summarize this channel");
    expect(claim.appendSystemPrompt).toContain(
      "You are currently running inside: Slack",
    );
    expect(claim.appendSystemPrompt).toContain("Channel type: Channel");
    const state = await readSlackState(fixture);
    expect(state.recent_runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: claim.runId, triggerSource: "slack" }),
      ]),
    );
  });

  it("synchronously dispatches connected direct-message probes", async () => {
    const fixture = await track(
      seedSlackProbeFixture({ withConnection: true, withDefaultAgent: true }),
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "D-test",
      user_id: fixture.slackUserId,
      message_text: "hello in dm",
      message_ts: "1710000001.000000",
      channel_type: "im",
    });

    expect(response.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(response),
    ).resolves.toStrictEqual({ ok: true });

    const claim = await claimSlackRunnerJob(fixture, "hello in dm");
    expect(claim.prompt).toBe("hello in dm");
    expect(claim.appendSystemPrompt).toContain("Channel type: Direct message");
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D-test",
        thread_ts: "1710000001.000000",
      }),
    );
  });

  it("includes Slack thread computer use host bindings in queued zero tokens", async () => {
    const fixture = await track(
      seedSlackProbeFixture({ withConnection: true, withDefaultAgent: true }),
    );
    const channelId = "C-test";
    const threadTs = "1710000004.000000";
    const actor = actorForFixture(fixture);
    await enableComputerUseDelegatedAuthorization(fixture);
    const host = await computerUseApi.startComputerUseHost(actor, {
      hostName: "Slack authorized host",
    });

    const firstResponse = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: channelId,
      user_id: fixture.slackUserId,
      message_text: "authorize the browser",
      message_ts: threadTs,
      channel_type: "channel",
    });

    expect(firstResponse.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(firstResponse),
    ).resolves.toStrictEqual({ ok: true });

    const firstClaim = await claimSlackRunnerJob(
      fixture,
      "authorize the browser",
    );
    const firstZeroToken = firstClaim.environment?.ZERO_TOKEN;
    if (!firstZeroToken) {
      throw new Error("Claimed runner job did not include ZERO_TOKEN");
    }
    const created = await computerUseApi.createComputerUseAuthorizationRequest({
      bearer: firstZeroToken,
    });
    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    await computerUseApi.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    await completeClaimedRun(firstClaim.runId, firstClaim.sandboxToken);

    const secondResponse = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: channelId,
      user_id: fixture.slackUserId,
      message_text: "use the browser",
      message_ts: threadTs,
      channel_type: "channel",
    });
    expect(secondResponse.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(secondResponse),
    ).resolves.toStrictEqual({ ok: true });

    const claim = await claimSlackRunnerJob(fixture, "use the browser");
    const zeroToken = claim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error("Claimed runner job did not include ZERO_TOKEN");
    }
    const zeroAuth = verifyZeroToken(zeroToken);
    expect(zeroAuth).toMatchObject({ computerUseHostId: host.hostId });
    expect(zeroAuth?.capabilities).toContain("computer-use:write");
    await computerUseApi.deleteComputerUseHost(actor, host.hostId);
  });

  it("serializes synchronous dispatch errors as diagnostic 200 responses", async () => {
    const fixture = await track(
      seedSlackProbeFixture({ withConnection: true, withDefaultAgent: true }),
    );
    const statusError = Object.assign(new Error("status update failed"), {
      code: "slack_status_failed",
    });
    context.mocks.slack.assistant.threads.setStatus.mockRejectedValueOnce(
      statusError,
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: fixture.slackUserId,
      message_text: "trigger an error",
      message_ts: "1710000002.000000",
    });

    expect(response.status).toBe(200);
    const body = await readJson<TestSlackDispatchProbeResponse>(response);
    expect(body).toMatchObject({
      ok: false,
      error: {
        name: "Error",
        message: "status update failed",
        code: "slack_status_failed",
      },
    });
  });
});
