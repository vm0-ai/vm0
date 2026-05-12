import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import type { TestSlackStateResponse } from "@vm0/api-contracts/contracts/test-slack-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { e2eSlackMockCallLog } from "@vm0/db/schema/e2e-slack-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

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
  readonly mockCallMethods: readonly string[];
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

async function seedSlackStateFixture(): Promise<SlackStateFixture> {
  const id = suffix();
  const teamId = `T_${id}`;
  const orgId = `org_${id}`;
  const userId = `user_${id}`;
  const composeId = randomUUID();
  const versionId = suffix();
  const runId = randomUUID();
  const sessionId = randomUUID();
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
    mockCallMethods: [newerMockMethod, olderMockMethod],
  };
}

async function cleanupSlackStateFixture(
  fixture: SlackStateFixture,
): Promise<void> {
  await writeDb
    .delete(e2eSlackMockCallLog)
    .where(inArray(e2eSlackMockCallLog.method, fixture.mockCallMethods));
  await writeDb.delete(zeroRuns).where(eq(zeroRuns.id, fixture.runId));
  await writeDb.delete(agentRuns).where(eq(agentRuns.id, fixture.runId));
  await writeDb
    .delete(agentSessions)
    .where(eq(agentSessions.id, fixture.sessionId));
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

const trackSlackStateFixture = createFixtureTracker(cleanupSlackStateFixture);

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
