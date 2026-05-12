import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import type {
  TestSlackStateDeleteResponse,
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { e2eSlackMockCallLog } from "@vm0/db/schema/e2e-slack-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);

const ROUTE = "/api/test/slack-state";

interface SlackStateFixture {
  readonly teamId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly nonSlackRunId: string | undefined;
  readonly nonSlackSessionId: string | undefined;
  readonly mockCallMethods: readonly string[];
}

interface SlackStateFixtureOptions {
  readonly seedNonSlackRun?: boolean;
}

interface SlackSeedFixture {
  readonly teamId: string;
  readonly orgId: string;
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function postSlackState(body: unknown): Promise<Response> {
  return requestApp(ROUTE, {
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
    data: [
      { createdAt: 20, organization: { id: `org_later_${suffix()}` } },
      { createdAt: 10, organization: { id: orgId } },
    ],
  });
}

async function seedSlackStateFixture(
  options: SlackStateFixtureOptions = {},
): Promise<SlackStateFixture> {
  const id = suffix();
  const teamId = `T_${id}`;
  const orgId = `org_${id}`;
  const userId = `user_${id}`;
  const composeId = randomUUID();
  const versionId = suffix();
  const runId = randomUUID();
  const sessionId = randomUUID();
  const nonSlackRunId = options.seedNonSlackRun ? randomUUID() : undefined;
  const nonSlackSessionId = options.seedNonSlackRun ? randomUUID() : undefined;
  const newerMockMethod = `chat.postMessage.${id}`;
  const olderMockMethod = `users.info.${id}`;

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: "e2e-slack-agent",
    headVersionId: versionId,
  });
  await writeDb.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: { env: {}, prompts: [] },
    createdBy: userId,
  });
  await writeDb.insert(zeroAgents).values({
    id: composeId,
    orgId,
    owner: userId,
    name: "slack-agent",
  });
  await writeDb.insert(orgMetadata).values({
    orgId,
    defaultAgentId: composeId,
    credits: 1234,
    tier: "pro",
  });
  await writeDb.insert(slackOrgInstallations).values({
    slackWorkspaceId: teamId,
    slackWorkspaceName: "E2E Slack Workspace",
    orgId,
    encryptedBotToken: "encrypted-slack-token",
    botUserId: "U_BOT",
    installedByUserId: userId,
  });
  await writeDb.insert(slackOrgConnections).values({
    slackWorkspaceId: teamId,
    slackUserId: "U_SLACK_USER",
    vm0UserId: userId,
    dmWelcomeSent: true,
  });
  await writeDb.insert(agentSessions).values({
    id: sessionId,
    userId,
    orgId,
    agentComposeId: composeId,
  });
  await writeDb.insert(agentRuns).values({
    id: runId,
    userId,
    orgId,
    sessionId,
    status: "completed",
    prompt: "hello from slack diagnostics",
    error: "diagnostic error",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  await writeDb.insert(zeroRuns).values({
    id: runId,
    triggerSource: "slack",
  });
  if (nonSlackRunId && nonSlackSessionId) {
    await writeDb.insert(agentSessions).values({
      id: nonSlackSessionId,
      userId,
      orgId,
      agentComposeId: composeId,
    });
    await writeDb.insert(agentRuns).values({
      id: nonSlackRunId,
      userId,
      orgId,
      sessionId: nonSlackSessionId,
      status: "completed",
      prompt: "hello from manual diagnostics",
      createdAt: new Date("2029-01-01T00:00:00.000Z"),
    });
    await writeDb.insert(zeroRuns).values({
      id: nonSlackRunId,
      triggerSource: "manual",
    });
  }
  await writeDb.insert(e2eSlackMockCallLog).values([
    {
      method: olderMockMethod,
      teamId,
      channelId: "C_OLDER",
      body: '{"text":"older"}',
      bodyJson: { text: "older" },
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    },
    {
      method: newerMockMethod,
      teamId,
      channelId: "C_NEWER",
      body: '{"text":"newer"}',
      bodyJson: { text: "newer" },
      createdAt: new Date("2030-01-01T00:00:01.000Z"),
    },
  ]);

  return {
    teamId,
    orgId,
    userId,
    composeId,
    versionId,
    runId,
    sessionId,
    nonSlackRunId,
    nonSlackSessionId,
    mockCallMethods: [newerMockMethod, olderMockMethod],
  };
}

async function cleanupSlackStateFixture(
  fixture: SlackStateFixture,
): Promise<void> {
  const runIds = [fixture.runId];
  if (fixture.nonSlackRunId) {
    runIds.push(fixture.nonSlackRunId);
  }
  const sessionIds = [fixture.sessionId];
  if (fixture.nonSlackSessionId) {
    sessionIds.push(fixture.nonSlackSessionId);
  }

  await writeDb
    .delete(e2eSlackMockCallLog)
    .where(inArray(e2eSlackMockCallLog.method, fixture.mockCallMethods));
  await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
  await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  await writeDb
    .delete(agentSessions)
    .where(inArray(agentSessions.id, sessionIds));
  await writeDb
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, fixture.teamId));
  await writeDb
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, fixture.teamId));
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await writeDb.delete(zeroAgents).where(eq(zeroAgents.id, fixture.composeId));
  await writeDb
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.id, fixture.versionId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}

async function cleanupSlackSeedFixture(
  fixture: SlackSeedFixture,
): Promise<void> {
  const composeRows = await writeDb
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.orgId, fixture.orgId));
  const composeIds = composeRows.map((compose) => {
    return compose.id;
  });

  await writeDb
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, fixture.teamId));
  await writeDb
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, fixture.teamId));
  await writeDb
    .delete(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, fixture.orgId));
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));

  if (composeIds.length > 0) {
    await writeDb.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
    await writeDb
      .delete(agentComposeVersions)
      .where(inArray(agentComposeVersions.composeId, composeIds));
    await writeDb
      .delete(agentComposes)
      .where(inArray(agentComposes.id, composeIds));
  }
}

const trackSlackStateFixture = createFixtureTracker(cleanupSlackStateFixture);
const trackSlackSeedFixture = createFixtureTracker(cleanupSlackSeedFixture);

describe("GET /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${ROUTE}?team_id=T_DENIED`);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires the preview bypass secret in preview", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const denied = await requestApp(`${ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "wrong" },
    });
    const allowed = await requestApp(`${ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "preview-secret" },
    });

    expect(denied.status).toBe(404);
    await expect(denied.text()).resolves.toBe("Not found");
    expect(allowed.status).toBe(200);
  });

  it("requires team_id", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(ROUTE);

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id query param is required",
    });
  });

  it("returns empty workspace diagnostics for an unknown team", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("SLACK_API_URL", "https://slack.example.test/api/");

    const response = await requestApp(`${ROUTE}?team_id=T_UNKNOWN`);
    const body = await readJson<TestSlackStateResponse>(response);

    expect(response.status).toBe(200);
    expect(body.installation).toBeNull();
    expect(body.connections).toStrictEqual([]);
    expect(body.recent_runs).toStrictEqual([]);
    expect(body.org_metadata).toBeNull();
    expect(body.default_agent).toBeNull();
    expect(body.default_compose).toBeNull();
    expect(body.default_compose_version).toBeNull();
    expect(body.resolved_slack_api_url).toBe("https://slack.example.test/api/");
    expect(Array.isArray(body.mock_calls)).toBeTruthy();
  });

  it("resolves the preview Slack mock URL", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("E2E_SLACK_MOCK_ENABLED", "true");
    mockOptionalEnv("VERCEL_URL", "preview.vm0.test");

    const response = await requestApp(`${ROUTE}?team_id=T_UNKNOWN`);
    const body = await readJson<TestSlackStateResponse>(response);

    expect(response.status).toBe(200);
    expect(body.resolved_slack_api_url).toBe(
      "https://preview.vm0.test/api/test/slack-mock/",
    );
  });

  it("returns Slack installation diagnostics, recent runs, default agent metadata, and mock calls", async () => {
    mockEnv("ENV", "development");
    const fixture = await trackSlackStateFixture(seedSlackStateFixture());

    const response = await requestApp(`${ROUTE}?team_id=${fixture.teamId}`);
    const body = await readJson<TestSlackStateResponse>(response);

    expect(response.status).toBe(200);
    expect(body.installation).toMatchObject({
      slackWorkspaceId: fixture.teamId,
      slackWorkspaceName: "E2E Slack Workspace",
      orgId: fixture.orgId,
      botUserId: "U_BOT",
      installedByUserId: fixture.userId,
    });
    expect(typeof body.installation?.createdAt).toBe("string");
    expect(body.connections).toMatchObject([
      {
        slackUserId: "U_SLACK_USER",
        vm0UserId: fixture.userId,
        dmWelcomeSent: true,
      },
    ]);
    expect(body.recent_runs).toMatchObject([
      {
        id: fixture.runId,
        status: "completed",
        triggerSource: "slack",
        userId: fixture.userId,
        error: "diagnostic error",
        promptPreview: "hello from slack diagnostics",
      },
    ]);
    expect(body.org_metadata).toStrictEqual({
      orgId: fixture.orgId,
      defaultAgentId: fixture.composeId,
      credits: 1234,
      tier: "pro",
    });
    expect(body.default_agent).toStrictEqual({
      id: fixture.composeId,
      name: "slack-agent",
      orgId: fixture.orgId,
    });
    expect(body.default_compose).toStrictEqual({
      id: fixture.composeId,
      name: "e2e-slack-agent",
      headVersionId: fixture.versionId,
    });
    expect(body.default_compose_version).toStrictEqual({
      id: fixture.versionId,
      content_keys: ["env", "prompts"],
    });
    expect(body.mock_calls.slice(0, 2)).toMatchObject([
      {
        method: fixture.mockCallMethods[0],
        teamId: fixture.teamId,
        channelId: "C_NEWER",
        bodyJson: { text: "newer" },
      },
      {
        method: fixture.mockCallMethods[1],
        teamId: fixture.teamId,
        channelId: "C_OLDER",
        bodyJson: { text: "older" },
      },
    ]);
  });
});

describe("POST /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await postSlackState({
      team_id: "T_DENIED",
      slack_user_id: "U_DENIED",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires team_id and slack_user_id", async () => {
    mockEnv("ENV", "development");

    const response = await postSlackState({ team_id: "T_MISSING_USER" });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id and slack_user_id are required",
    });
  });

  it("seeds a Slack installation without optional state", async () => {
    mockEnv("ENV", "development");
    const id = suffix();
    const teamId = `T_SEED_${id}`;
    const orgId = `org_seed_${id}`;
    const userId = `user_seed_${id}`;
    await trackSlackSeedFixture(Promise.resolve({ teamId, orgId }));
    mockTestUserMembership(userId, orgId);

    const response = await postSlackState({
      team_id: teamId,
      slack_user_id: "U_E2E_MEMBER",
      workspace_name: "Seeded Workspace",
      bot_user_id: "U_CUSTOM_BOT",
      email: "seeded@example.test",
    });
    const body = await readJson<TestSlackStatePostResponse>(response);

    expect(response.status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      team_id: teamId,
      org_id: orgId,
      vm0_user_id: userId,
      connection_id: null,
      default_agent_id: null,
    });

    const installations = await writeDb
      .select({
        slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
        slackWorkspaceName: slackOrgInstallations.slackWorkspaceName,
        orgId: slackOrgInstallations.orgId,
        botUserId: slackOrgInstallations.botUserId,
        botScopes: slackOrgInstallations.botScopes,
        installedByUserId: slackOrgInstallations.installedByUserId,
      })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, teamId));

    expect(installations).toStrictEqual([
      {
        slackWorkspaceId: teamId,
        slackWorkspaceName: "Seeded Workspace",
        orgId,
        botUserId: "U_CUSTOM_BOT",
        botScopes: "chat:write,im:write,users:read",
        installedByUserId: userId,
      },
    ]);
    await expect(
      writeDb
        .select({ id: slackOrgConnections.id })
        .from(slackOrgConnections)
        .where(eq(slackOrgConnections.slackWorkspaceId, teamId)),
    ).resolves.toStrictEqual([]);
  });

  it("optionally seeds a Slack connection", async () => {
    mockEnv("ENV", "development");
    const id = suffix();
    const teamId = `T_CONNECT_${id}`;
    const orgId = `org_connect_${id}`;
    const userId = `user_connect_${id}`;
    await trackSlackSeedFixture(Promise.resolve({ teamId, orgId }));
    mockTestUserMembership(userId, orgId);

    const response = await postSlackState({
      team_id: teamId,
      slack_user_id: "U_E2E_CONNECTED",
      seed_connection: true,
    });
    const body = await readJson<TestSlackStatePostResponse>(response);

    expect(response.status).toBe(200);
    expect(typeof body.connection_id).toBe("string");
    expect(body.default_agent_id).toBeNull();
    await expect(
      writeDb
        .select({
          id: slackOrgConnections.id,
          slackUserId: slackOrgConnections.slackUserId,
          slackWorkspaceId: slackOrgConnections.slackWorkspaceId,
          vm0UserId: slackOrgConnections.vm0UserId,
          dmWelcomeSent: slackOrgConnections.dmWelcomeSent,
        })
        .from(slackOrgConnections)
        .where(eq(slackOrgConnections.slackWorkspaceId, teamId)),
    ).resolves.toStrictEqual([
      {
        id: body.connection_id,
        slackUserId: "U_E2E_CONNECTED",
        slackWorkspaceId: teamId,
        vm0UserId: userId,
        dmWelcomeSent: false,
      },
    ]);
  });

  it("optionally seeds the default Slack agent", async () => {
    mockEnv("ENV", "development");
    const id = suffix();
    const teamId = `T_AGENT_${id}`;
    const orgId = `org_agent_${id}`;
    const userId = `user_agent_${id}`;
    await trackSlackSeedFixture(Promise.resolve({ teamId, orgId }));
    mockTestUserMembership(userId, orgId);

    const response = await postSlackState({
      team_id: teamId,
      slack_user_id: "U_E2E_AGENT",
      seed_default_agent: true,
    });
    const body = await readJson<TestSlackStatePostResponse>(response);

    expect(response.status).toBe(200);
    expect(typeof body.default_agent_id).toBe("string");
    expect(body.connection_id).toBeNull();
    if (!body.default_agent_id) {
      throw new Error("Expected seeded default agent id");
    }
    const defaultAgentId = body.default_agent_id;

    const [compose] = await writeDb
      .select({
        id: agentComposes.id,
        userId: agentComposes.userId,
        orgId: agentComposes.orgId,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, defaultAgentId));
    const [agent] = await writeDb
      .select({
        id: zeroAgents.id,
        orgId: zeroAgents.orgId,
        owner: zeroAgents.owner,
        name: zeroAgents.name,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, defaultAgentId));
    const [metadata] = await writeDb
      .select({
        orgId: orgMetadata.orgId,
        defaultAgentId: orgMetadata.defaultAgentId,
        credits: orgMetadata.credits,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId));
    const [creditGrant] = await writeDb
      .select({
        orgId: creditExpiresRecord.orgId,
        source: creditExpiresRecord.source,
        amount: creditExpiresRecord.amount,
        remaining: creditExpiresRecord.remaining,
      })
      .from(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, orgId));
    const [version] = await writeDb
      .select({
        id: agentComposeVersions.id,
        content: agentComposeVersions.content,
      })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, defaultAgentId));

    expect(compose).toMatchObject({
      id: defaultAgentId,
      userId,
      orgId,
      name: "e2e-slack-agent",
    });
    expect(compose?.headVersionId).toBe(version?.id);
    expect(agent).toStrictEqual({
      id: defaultAgentId,
      orgId,
      owner: userId,
      name: "e2e-slack-agent",
    });
    expect(metadata).toStrictEqual({
      orgId,
      defaultAgentId,
      credits: 10_000,
    });
    expect(creditGrant).toStrictEqual({
      orgId,
      source: "starter_grant",
      amount: 10_000,
      remaining: 10_000,
    });
    expect(version?.content).toStrictEqual({
      version: "1.0",
      agents: {
        "e2e-slack-agent": {
          framework: "claude-code",
          environment: {
            ANTHROPIC_API_KEY: "fake-e2e-anthropic-key",
          },
        },
      },
    });
  });

  it("is idempotent for existing installations, connections, and default agents", async () => {
    mockEnv("ENV", "development");
    const id = suffix();
    const teamId = `T_IDEMPOTENT_${id}`;
    const orgId = `org_idempotent_${id}`;
    const userId = `user_idempotent_${id}`;
    await trackSlackSeedFixture(Promise.resolve({ teamId, orgId }));
    mockTestUserMembership(userId, orgId);

    const firstResponse = await postSlackState({
      team_id: teamId,
      slack_user_id: "U_E2E_IDEMPOTENT",
      seed_connection: true,
      seed_default_agent: true,
    });
    const first = await readJson<TestSlackStatePostResponse>(firstResponse);
    const secondResponse = await postSlackState({
      team_id: teamId,
      slack_user_id: "U_E2E_IDEMPOTENT",
      seed_connection: true,
      seed_default_agent: true,
    });
    const second = await readJson<TestSlackStatePostResponse>(secondResponse);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(typeof first.connection_id).toBe("string");
    if (!first.default_agent_id) {
      throw new Error("Expected seeded default agent id");
    }
    expect(second.connection_id).toBeNull();
    expect(second.default_agent_id).toBe(first.default_agent_id);

    const installations = await writeDb
      .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, teamId));
    const connections = await writeDb
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(eq(slackOrgConnections.slackWorkspaceId, teamId));
    const composes = await writeDb
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, orgId),
          eq(agentComposes.name, "e2e-slack-agent"),
        ),
      );
    const starterGrants = await writeDb
      .select({ id: creditExpiresRecord.id })
      .from(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, orgId));

    expect(installations).toStrictEqual([{ slackWorkspaceId: teamId }]);
    expect(connections).toStrictEqual([{ id: first.connection_id }]);
    expect(composes).toStrictEqual([{ id: first.default_agent_id }]);
    expect(starterGrants).toHaveLength(1);
  });
});

describe("DELETE /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${ROUTE}?team_id=T_DENIED`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires team_id", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(ROUTE, { method: "DELETE" });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id query param is required",
    });
  });

  it("clears workspace Slack state without deleting mock calls or non-Slack runs", async () => {
    mockEnv("ENV", "development");
    const fixture = await trackSlackStateFixture(
      seedSlackStateFixture({ seedNonSlackRun: true }),
    );
    if (!fixture.nonSlackRunId) {
      throw new Error("Expected non-Slack run fixture row");
    }

    const response = await requestApp(`${ROUTE}?team_id=${fixture.teamId}`, {
      method: "DELETE",
    });
    const body = await readJson<TestSlackStateDeleteResponse>(response);

    expect(response.status).toBe(200);
    expect(body).toStrictEqual({ ok: true });

    await expect(
      writeDb
        .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
        .from(slackOrgInstallations)
        .where(eq(slackOrgInstallations.slackWorkspaceId, fixture.teamId)),
    ).resolves.toStrictEqual([]);
    await expect(
      writeDb
        .select({ id: slackOrgConnections.id })
        .from(slackOrgConnections)
        .where(eq(slackOrgConnections.slackWorkspaceId, fixture.teamId)),
    ).resolves.toStrictEqual([]);
    await expect(
      writeDb
        .select({ id: zeroRuns.id })
        .from(zeroRuns)
        .where(eq(zeroRuns.id, fixture.runId)),
    ).resolves.toStrictEqual([]);
    await expect(
      writeDb
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, fixture.runId)),
    ).resolves.toStrictEqual([]);
    await expect(
      writeDb
        .select({ id: zeroRuns.id, triggerSource: zeroRuns.triggerSource })
        .from(zeroRuns)
        .where(eq(zeroRuns.id, fixture.nonSlackRunId)),
    ).resolves.toStrictEqual([
      { id: fixture.nonSlackRunId, triggerSource: "manual" },
    ]);
    await expect(
      writeDb
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, fixture.nonSlackRunId)),
    ).resolves.toStrictEqual([{ id: fixture.nonSlackRunId }]);

    const mockCalls = await writeDb
      .select({ method: e2eSlackMockCallLog.method })
      .from(e2eSlackMockCallLog)
      .where(inArray(e2eSlackMockCallLog.method, fixture.mockCallMethods));

    expect(
      mockCalls.map((call) => {
        return call.method;
      }),
    ).toStrictEqual(expect.arrayContaining([...fixture.mockCallMethods]));
  });
});
