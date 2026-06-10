import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testSlackMockContract } from "@vm0/api-contracts/contracts/test-slack-mock";
import {
  testSlackStateContract,
  type TestSlackStatePostResponse,
  type TestSlackStateResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const ROUTE = "/api/test/slack-state";

interface SeededSlackState {
  readonly teamId: string;
  readonly response: TestSlackStatePostResponse;
}

function stateClient() {
  return setupApp({ context })(testSlackStateContract);
}

function slackMockClient() {
  return setupApp({ context })(testSlackMockContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

function mockTestUserMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { createdAt: 20, organization: { id: `org_later_${suffix()}` } },
      { createdAt: 10, organization: { id: orgId } },
    ],
  });
}

async function cleanupSeededSlackState(
  seeded: SeededSlackState,
): Promise<void> {
  mockEnv("ENV", "development");
  await accept(
    stateClient().delete({ query: { team_id: seeded.teamId } }),
    [200],
  );

  const agentId = seeded.response.default_agent_id;
  if (!agentId) {
    return;
  }

  mocks.clerk.session(
    seeded.response.vm0_user_id,
    seeded.response.org_id,
    "org:admin",
  );
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      params: { id: agentId },
      headers: authHeaders(),
    }),
    [204, 404, 409],
  );
}

const trackSeededState = createFixtureTracker<SeededSlackState>(
  cleanupSeededSlackState,
);

async function seedSlackState(args: {
  readonly teamId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly slackUserId: string;
  readonly seedConnection?: boolean;
  readonly seedDefaultAgent?: boolean;
  readonly seedSlackRun?: boolean;
  readonly seedNonSlackRun?: boolean;
}): Promise<TestSlackStatePostResponse> {
  mockEnv("ENV", "development");
  mockTestUserMembership(args.userId, args.orgId);

  const response = await accept(
    stateClient().post({
      body: {
        team_id: args.teamId,
        slack_user_id: args.slackUserId,
        workspace_name: "Seeded Workspace",
        bot_user_id: "U_CUSTOM_BOT",
        seed_connection: args.seedConnection,
        seed_default_agent: args.seedDefaultAgent,
        seed_slack_run: args.seedSlackRun,
        seed_non_slack_run: args.seedNonSlackRun,
      },
    }),
    [200],
  );

  await trackSeededState(
    Promise.resolve({ teamId: args.teamId, response: response.body }),
  );
  return response.body;
}

async function readState(teamId: string): Promise<TestSlackStateResponse> {
  const response = await accept(
    stateClient().get({ query: { team_id: teamId } }),
    [200],
  );
  return response.body;
}

function findRun(
  state: TestSlackStateResponse,
  runId: string,
): TestSlackStateResponse["recent_runs"][number] | undefined {
  return state.recent_runs.find((run) => {
    return run.id === runId;
  });
}

function findMockCall(
  state: TestSlackStateResponse,
  args: { readonly teamId: string; readonly channelId: string },
): TestSlackStateResponse["mock_calls"][number] | undefined {
  return state.mock_calls.find((call) => {
    return call.teamId === args.teamId && call.channelId === args.channelId;
  });
}

describe("/api/test/slack-state BDD", () => {
  it("gates the test endpoint and returns empty diagnostics for unknown teams", async () => {
    mockEnv("ENV", "production");

    const hiddenGet = await accept(
      stateClient().get({ query: { team_id: "T_DENIED" } }),
      [404],
    );
    const hiddenPost = await accept(
      stateClient().post({
        body: { team_id: "T_DENIED", slack_user_id: "U_DENIED" },
      }),
      [404],
    );
    const hiddenDelete = await accept(
      stateClient().delete({ query: { team_id: "T_DENIED" } }),
      [404],
    );

    expect(hiddenGet.body).toBe("Not found");
    expect(hiddenPost.body).toBe("Not found");
    expect(hiddenDelete.body).toBe("Not found");

    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const deniedPreview = await rawRequest(`${ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "wrong" },
    });
    const allowedPreview = await rawRequest(`${ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "preview-secret" },
    });

    expect(deniedPreview.status).toBe(404);
    await expect(deniedPreview.text()).resolves.toBe("Not found");
    expect(allowedPreview.status).toBe(200);

    mockEnv("ENV", "development");
    const missingTeam = await accept(stateClient().get({ query: {} }), [400]);
    const missingDeleteTeam = await accept(
      stateClient().delete({ query: {} }),
      [400],
    );
    const missingPostFields = await accept(
      stateClient().post({ body: { team_id: "T_MISSING_USER" } }),
      [400],
    );
    const invalidPostBody = await rawRequest(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(missingTeam.body).toStrictEqual({
      error: "team_id query param is required",
    });
    expect(missingDeleteTeam.body).toStrictEqual({
      error: "team_id query param is required",
    });
    expect(missingPostFields.body).toStrictEqual({
      error: "team_id and slack_user_id are required",
    });
    expect(invalidPostBody.status).toBe(400);
    await expect(invalidPostBody.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    mockOptionalEnv("SLACK_API_URL", "https://slack.example.test/api/");
    const unknown = await readState("T_UNKNOWN");

    expect(unknown.installation).toBeNull();
    expect(unknown.connections).toStrictEqual([]);
    expect(unknown.recent_runs).toStrictEqual([]);
    expect(unknown.org_metadata).toBeNull();
    expect(unknown.default_agent).toBeNull();
    expect(unknown.default_compose).toBeNull();
    expect(unknown.default_compose_version).toBeNull();
    expect(unknown.resolved_slack_api_url).toBe(
      "https://slack.example.test/api/",
    );

    mockOptionalEnv("SLACK_API_URL", undefined);
    mockOptionalEnv("E2E_SLACK_MOCK_ENABLED", "true");
    mockOptionalEnv("VERCEL_URL", "preview.vm0.test");
    const previewMock = await readState("T_UNKNOWN");

    expect(previewMock.resolved_slack_api_url).toBe(
      "https://preview.vm0.test/api/test/slack-mock/",
    );
  });

  it("seeds, reads, and clears Slack workspace state through API-visible diagnostics", async () => {
    const bareId = suffix();
    const bareTeamId = `T_BARE_${bareId}`;
    const bareUserId = `user_bare_${bareId}`;
    const bareOrgId = `org_bare_${bareId}`;
    const bareSeed = await seedSlackState({
      teamId: bareTeamId,
      userId: bareUserId,
      orgId: bareOrgId,
      slackUserId: `U_BARE_${bareId}`,
    });
    const bareState = await readState(bareTeamId);

    expect(bareSeed).toStrictEqual({
      ok: true,
      team_id: bareTeamId,
      org_id: bareOrgId,
      vm0_user_id: bareUserId,
      connection_id: null,
      default_agent_id: null,
      slack_run_id: null,
      non_slack_run_id: null,
    });
    expect(bareState.installation).toMatchObject({
      slackWorkspaceId: bareTeamId,
      orgId: bareOrgId,
      installedByUserId: bareUserId,
    });
    expect(bareState.connections).toStrictEqual([]);
    expect(bareState.org_metadata).toBeNull();
    expect(bareState.default_agent).toBeNull();

    const id = suffix();
    const teamId = `T_STATE_${id}`;
    const userId = `user_state_${id}`;
    const orgId = `org_state_${id}`;
    const slackUserId = `U_STATE_${id}`;

    const seeded = await seedSlackState({
      teamId,
      userId,
      orgId,
      slackUserId,
      seedConnection: true,
      seedDefaultAgent: true,
      seedSlackRun: true,
      seedNonSlackRun: true,
    });

    expect(seeded).toMatchObject({
      ok: true,
      team_id: teamId,
      org_id: orgId,
      vm0_user_id: userId,
      default_agent_id: expect.any(String),
      slack_run_id: expect.any(String),
      non_slack_run_id: expect.any(String),
    });
    expect(seeded.connection_id).toStrictEqual(expect.any(String));

    await accept(
      slackMockClient().chatPostMessage({
        body: {
          team_id: teamId,
          channel: "C_STATE_NEWER",
          text: "newer",
        },
      }),
      [200],
    );
    await accept(
      slackMockClient().chatPostEphemeral({
        body: {
          team_id: teamId,
          channel_id: "C_STATE_OLDER",
          text: "older",
        },
      }),
      [200],
    );

    const state = await readState(teamId);

    expect(state.installation).toMatchObject({
      slackWorkspaceId: teamId,
      slackWorkspaceName: "Seeded Workspace",
      orgId,
      botUserId: "U_CUSTOM_BOT",
      installedByUserId: userId,
    });
    expect(state.connections).toMatchObject([
      {
        id: seeded.connection_id,
        slackUserId,
        vm0UserId: userId,
        dmWelcomeSent: false,
      },
    ]);
    expect(state.org_metadata).toStrictEqual({
      orgId,
      defaultAgentId: seeded.default_agent_id,
      credits: 10_000,
      tier: "free",
    });
    expect(state.default_agent).toMatchObject({
      id: seeded.default_agent_id,
      name: "e2e-slack-agent",
      orgId,
    });
    expect(state.default_compose).toMatchObject({
      id: seeded.default_agent_id,
      name: "e2e-slack-agent",
    });
    expect(state.default_compose_version?.content_keys).toStrictEqual(
      expect.arrayContaining(["version", "agents"]),
    );

    const slackRun = seeded.slack_run_id
      ? findRun(state, seeded.slack_run_id)
      : undefined;
    const nonSlackRun = seeded.non_slack_run_id
      ? findRun(state, seeded.non_slack_run_id)
      : undefined;
    expect(slackRun).toMatchObject({
      status: "completed",
      triggerSource: "slack",
      userId,
      error: "diagnostic error",
      promptPreview: "hello from slack diagnostics",
    });
    expect(nonSlackRun).toMatchObject({
      status: "completed",
      triggerSource: "manual",
      userId,
      error: null,
      promptPreview: "hello from manual diagnostics",
    });
    expect(
      findMockCall(state, { teamId, channelId: "C_STATE_NEWER" }),
    ).toMatchObject({
      method: "chat.postMessage",
      teamId,
      channelId: "C_STATE_NEWER",
      bodyJson: {
        team_id: teamId,
        channel: "C_STATE_NEWER",
        text: "newer",
      },
    });
    expect(
      findMockCall(state, { teamId, channelId: "C_STATE_OLDER" }),
    ).toMatchObject({
      method: "chat.postEphemeral",
      teamId,
      channelId: "C_STATE_OLDER",
      bodyJson: {
        team_id: teamId,
        channel_id: "C_STATE_OLDER",
        text: "older",
      },
    });

    const idempotent = await seedSlackState({
      teamId,
      userId,
      orgId,
      slackUserId,
      seedConnection: true,
      seedDefaultAgent: true,
    });

    expect(idempotent.connection_id).toBeNull();
    expect(idempotent.default_agent_id).toBe(seeded.default_agent_id);

    const deleted = await accept(
      stateClient().delete({ query: { team_id: teamId } }),
      [200],
    );

    expect(deleted.body).toStrictEqual({ ok: true });

    const cleared = await readState(teamId);

    expect(cleared.installation).toBeNull();
    expect(cleared.connections).toStrictEqual([]);
    expect(cleared.recent_runs).toStrictEqual([]);
    expect(
      findMockCall(cleared, { teamId, channelId: "C_STATE_NEWER" }),
    ).toBeDefined();

    const reseeded = await seedSlackState({
      teamId,
      userId,
      orgId,
      slackUserId,
      seedDefaultAgent: true,
    });
    const afterReseed = await readState(teamId);

    expect(reseeded.default_agent_id).toBe(seeded.default_agent_id);
    expect(
      seeded.slack_run_id ? findRun(afterReseed, seeded.slack_run_id) : null,
    ).toBeUndefined();
    expect(
      seeded.non_slack_run_id
        ? findRun(afterReseed, seeded.non_slack_run_id)
        : undefined,
    ).toMatchObject({
      triggerSource: "manual",
      promptPreview: "hello from manual diagnostics",
    });
  });
});
