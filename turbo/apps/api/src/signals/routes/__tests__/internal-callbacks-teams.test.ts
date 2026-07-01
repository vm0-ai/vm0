import { createHash } from "node:crypto";

import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { zeroTeamsConnectRoutes } from "../zero-teams-connect";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/zero-teams-connect";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const runsApi = createRunsAutomationsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const trackTeamsFixture = createFixtureTracker<TeamsConnectFixture>(
  async (fixture) => {
    await removeTeamsForTest(context.signal, fixture);
    await deleteFeatureSwitchesForUser(context, {
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
  },
);

const APP_URL = "https://app.vm0.test";
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const BOT_APP_PASSWORD = "teams-test-password";
const BOT_FRAMEWORK_TOKEN_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

interface TeamsPostedActivity {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly textFormat?: unknown;
  readonly replyToId?: unknown;
  readonly channelData?: unknown;
}

interface ConnectedTeamsActor {
  readonly fixture: TeamsConnectFixture;
  readonly runnerGroup: string;
}

function teamsServiceBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/u, "");
}

function recordFromUnknown(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function teamsPostedActivityFromUnknown(value: unknown): TeamsPostedActivity {
  return recordFromUnknown(
    value,
    "Expected Teams outbound activity object",
  ) as TeamsPostedActivity;
}

function teamsApiMocks(args: {
  readonly serviceUrl: string;
  readonly activityStatus?: number;
  readonly activityError?: string;
}): {
  readonly tokenRequests: URLSearchParams[];
  readonly postedActivities: TeamsPostedActivity[];
} {
  const tokenRequests: URLSearchParams[] = [];
  const postedActivities: TeamsPostedActivity[] = [];
  const serviceBaseUrl = teamsServiceBaseUrl(args.serviceUrl);

  server.use(
    http.post(BOT_FRAMEWORK_TOKEN_URL, async ({ request }) => {
      tokenRequests.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({
        access_token: "teams-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities`,
      async ({ request }) => {
        postedActivities.push(
          teamsPostedActivityFromUnknown(await request.json()),
        );
        if (args.activityStatus) {
          return new HttpResponse(args.activityError ?? "Teams API failed", {
            status: args.activityStatus,
          });
        }
        return HttpResponse.json({
          id: `teams-activity-${postedActivities.length}`,
        });
      },
    ),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId`,
      async ({ request }) => {
        postedActivities.push(
          teamsPostedActivityFromUnknown(await request.json()),
        );
        if (args.activityStatus) {
          return new HttpResponse(args.activityError ?? "Teams API failed", {
            status: args.activityStatus,
          });
        }
        return HttpResponse.json({
          id: `teams-activity-${postedActivities.length}`,
        });
      },
    ),
  );

  return { tokenRequests, postedActivities };
}

function dispatchRunId(body: unknown): string {
  const response = recordFromUnknown(
    body,
    "Expected Teams bot response object",
  );
  const dispatch = recordFromUnknown(
    response.dispatch,
    "Expected Teams dispatch object",
  );
  expect(
    dispatch.kind === "accepted" || dispatch.kind === "queued",
  ).toBeTruthy();
  if (typeof dispatch.runId !== "string") {
    throw new Error("Expected Teams dispatch run id");
  }
  return dispatch.runId;
}

async function connectTeamsFixture(
  fixture: TeamsConnectFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({
    context,
    routes: zeroTeamsConnectRoutes,
  })(zeroTeamsConnectContract);
  await accept(
    client.connect({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsUserDisplayName: "Ada Lovelace",
        teamsUserPrincipalName: "ada@example.com",
        teamId: fixture.teamsTeamId,
        teamName: fixture.teamsTeamName,
        serviceUrl: fixture.serviceUrl,
      },
    }),
    [200],
  );
}

async function setupConnectedTeamsActor(
  options: { readonly zeroDebug?: boolean } = {},
): Promise<ConnectedTeamsActor> {
  const fixture = await trackTeamsFixture(
    Promise.resolve(teamsConnectFixture()),
  );
  const actor = authOrgApi.user({
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
  });
  const runnerGroup = runsApi.configureRunnerGroup();

  context.mocks.ably.publish.mockResolvedValue(undefined);
  authOrgApi.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  const agent = await authOrgApi.createAgent(actor, {
    displayName: "Teams callback agent",
    visibility: "public",
  });
  await authOrgApi.setDefaultAgent(actor, agent.agentId);
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  if (options.zeroDebug) {
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "org:admin",
      },
      {
        [FeatureSwitchKey.ZeroDebug]: true,
      },
    );
  }
  await installTeamsForTest(context.signal, fixture);
  await connectTeamsFixture(fixture);

  return { fixture, runnerGroup };
}

async function dispatchTeamsRun(args: {
  readonly fixture: TeamsConnectFixture;
  readonly activityId: string;
  readonly threadId: string;
  readonly text: string;
}): Promise<string> {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity: teamsMessageActivityForTest(args.fixture, {
      id: args.activityId,
      replyToId: args.threadId,
      text: `<at>Zero</at> ${args.text}`,
    }),
  });
  expect(response.status).toBe(200);
  return dispatchRunId(await response.json());
}

async function claimTeamsRun(args: {
  readonly runnerGroup: string;
  readonly runId: string;
}) {
  await runsApi.heartbeatRunner(args.runnerGroup);
  return await runsApi.claimRunnerJob(args.runId);
}

async function completeSandboxRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly exitCode: number;
  readonly error?: string;
}): Promise<string | undefined> {
  const sandboxHeaders = { authorization: `Bearer ${args.sandboxToken}` };
  if (args.exitCode === 0) {
    const cliAgentSessionId = `bdd-teams-cli-${args.runId}`;
    await webhooksApi.requestAgentCheckpoint(
      {
        runId: args.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd teams history ${args.runId}`)
          .digest("hex"),
      },
      sandboxHeaders,
      [200],
    );
    await webhooksApi.requestAgentComplete(
      { runId: args.runId, exitCode: args.exitCode },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    return cliAgentSessionId;
  }

  await webhooksApi.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: args.exitCode,
      ...(args.error === undefined ? {} : { error: args.error }),
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
  return undefined;
}

async function claimFollowUpInThread(args: {
  readonly fixture: TeamsConnectFixture;
  readonly runnerGroup: string;
  readonly threadId: string;
  readonly activityId: string;
}) {
  const followUpRunId = await dispatchTeamsRun({
    fixture: args.fixture,
    activityId: args.activityId,
    threadId: args.threadId,
    text: "continue in the same thread",
  });
  await runsApi.heartbeatRunner(args.runnerGroup);
  return await runsApi.claimRunnerJob(followUpRunId, {
    capabilities: ["resumeSessionHistoryRef"],
  });
}

beforeEach(() => {
  setupTeamsConnectTestEnv(APP_URL);
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", BOT_APP_PASSWORD);
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.axiom.query.mockResolvedValue([]);
});

afterEach(() => {
  context.mocks.axiom.query.mockReset();
});

describe("Teams org internal callbacks", () => {
  it("posts completed run replies and persists Teams thread sessions", async () => {
    const teams = await setupConnectedTeamsActor({ zeroDebug: true });
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-completed-1",
      threadId: "root-completed",
      text: "finish the task",
    });
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });

    const cliAgentSessionId = await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 0,
    });

    expect(teamsApi.tokenRequests).toHaveLength(1);
    expect(teamsApi.tokenRequests[0]?.get("client_id")).toBe(BOT_APP_ID);
    expect(teamsApi.tokenRequests[0]?.get("client_secret")).toBe(
      BOT_APP_PASSWORD,
    );
    expect(teamsApi.postedActivities).toHaveLength(1);
    expect(teamsApi.postedActivities[0]).toMatchObject({
      type: "message",
      textFormat: "markdown",
      replyToId: "activity-completed-1",
      channelData: {
        tenant: { id: teams.fixture.teamsTenantId },
      },
    });
    expect(teamsApi.postedActivities[0]?.text).toContain(
      "Task completed successfully.",
    );
    expect(teamsApi.postedActivities[0]?.text).toContain(
      `[View run details](${APP_URL}/activities/${runId})`,
    );

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-completed",
      activityId: "activity-completed-follow-up",
    });
    expect(followUpClaim.resumeSession?.sessionId).toBe(cliAgentSessionId);
  });

  it("posts readable failed run replies without persisting a thread session", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-failed-1",
      threadId: "root-failed",
      text: "fail this task",
    });
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });

    await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 1,
      error: "Cannot continue session from checkpoint",
    });

    expect(teamsApi.postedActivities).toHaveLength(1);
    expect(teamsApi.postedActivities[0]?.text).toContain(
      "Cannot continue session from checkpoint",
    );

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-failed",
      activityId: "activity-failed-follow-up",
    });
    expect(followUpClaim.resumeSession).toBeNull();
  });

  it("does not post replies when the Teams installation is missing", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({ serviceUrl: teams.fixture.serviceUrl });
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-missing-install-1",
      threadId: "root-missing-install",
      text: "complete after uninstall",
    });
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });
    await removeTeamsForTest(context.signal, teams.fixture);

    await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 0,
    });

    expect(teamsApi.tokenRequests).toHaveLength(0);
    expect(teamsApi.postedActivities).toHaveLength(0);
    await installTeamsForTest(context.signal, teams.fixture);
    await connectTeamsFixture(teams.fixture);

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-missing-install",
      activityId: "activity-missing-install-follow-up",
    });
    expect(followUpClaim.resumeSession).toBeNull();
  });

  it("does not persist a thread session when the Teams API rejects the reply", async () => {
    const teams = await setupConnectedTeamsActor();
    const teamsApi = teamsApiMocks({
      serviceUrl: teams.fixture.serviceUrl,
      activityStatus: 500,
      activityError: "upstream exploded",
    });
    const runId = await dispatchTeamsRun({
      fixture: teams.fixture,
      activityId: "activity-teams-api-error-1",
      threadId: "root-teams-api-error",
      text: "complete while Teams is down",
    });
    const claim = await claimTeamsRun({
      runnerGroup: teams.runnerGroup,
      runId,
    });

    await completeSandboxRun({
      runId,
      sandboxToken: claim.sandboxToken,
      exitCode: 0,
    });

    expect(teamsApi.tokenRequests).toHaveLength(1);
    expect(teamsApi.postedActivities).toHaveLength(1);
    expect(teamsApi.postedActivities[0]?.text).toContain(
      "Task completed successfully.",
    );

    const followUpClaim = await claimFollowUpInThread({
      fixture: teams.fixture,
      runnerGroup: teams.runnerGroup,
      threadId: "root-teams-api-error",
      activityId: "activity-teams-api-error-follow-up",
    });
    expect(followUpClaim.resumeSession).toBeNull();
  });
});
