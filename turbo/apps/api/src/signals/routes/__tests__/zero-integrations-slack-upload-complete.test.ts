import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { integrationsSlackUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";
import {
  deleteUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const chatApi = createChatFilesBddApi(context);
const runsApi = createRunsAutomationsApi(context);

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: (args.capabilities ?? ["slack:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

interface RunScopedContext {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
}

describe("POST /api/zero/integrations/slack/upload-file/complete", () => {
  const slackFixtures: SlackIntegrationFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];
  const insightFixtures: UsageInsightFixture[] = [];

  function actorFor(args: { readonly orgId: string; readonly userId: string }) {
    return {
      orgId: args.orgId,
      userId: args.userId,
      orgRole: "org:admin",
      email: `${args.userId}@example.test`,
    } satisfies ApiTestUser;
  }

  async function visibleUploadedFiles(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
    readonly runId: string;
  }) {
    const artifacts = await chatApi.listThreadArtifacts(
      actorFor(args),
      args.threadId,
    );
    return (
      artifacts.runs.find((run) => {
        return run.runId === args.runId;
      })?.files ?? []
    );
  }

  beforeEach(() => {
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
  });

  afterEach(async () => {
    while (slackFixtures.length > 0) {
      const fixture = slackFixtures.pop();
      if (fixture) {
        await store.set(
          deleteSlackIntegrationFixture$,
          fixture,
          context.signal,
        );
      }
    }
    while (insightFixtures.length > 0) {
      const fixture = insightFixtures.pop();
      if (fixture) {
        await store.set(deleteUsageInsightFixture$, fixture, context.signal);
      }
    }
    while (memberships.length > 0) {
      const membership = memberships.pop();
      if (membership) {
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  function mockSlackFileInfo(fileId: string): void {
    context.mocks.slack.files.info.mockResolvedValue({
      ok: true,
      file: {
        id: fileId,
        name: "report.csv",
        title: "Slack Report",
        mimetype: "text/csv",
        filetype: "csv",
        size: 42,
        permalink: `https://slack.example/files/${fileId}`,
      },
    });
  }

  async function seedBaseContext(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    memberships.push(membership);
    insightFixtures.push({ orgId, userId });
    return { orgId, userId };
  }

  async function seedWithInstallation(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const base = await seedBaseContext();
    const fixture = await store.set(
      seedSlackOrgInstallation$,
      { orgId: base.orgId },
      context.signal,
    );
    slackFixtures.push(fixture);
    return base;
  }

  async function seedRunScoped(): Promise<RunScopedContext> {
    const base = await seedWithInstallation();
    const actor = actorFor(base);
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    const runnerGroup = runsApi.configureRunnerGroup();
    await runsApi.heartbeatRunner(runnerGroup);
    const agent = await bdd.createAgent(actor, {
      displayName: `Slack upload ${randomUUID().slice(0, 8)}`,
    });
    const sent = await chatApi.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Create a run for Slack upload completion",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected chat send to create a run for Slack upload");
    }
    return {
      orgId: base.orgId,
      userId: base.userId,
      runId: sent.body.runId,
      threadId: sent.body.threadId,
    };
  }

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when sandbox token lacks slack:write", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const token = sandboxToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:write");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const { orgId, userId } = await seedBaseContext();
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack installation");
  });

  it("forwards Slack file info errors as 400 SLACK_ERROR", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    const token = zeroToken({ userId, orgId, runId });
    context.mocks.slack.files.info.mockRejectedValueOnce(
      Object.assign(new Error("file_not_found"), {
        data: { ok: false, error: "file_not_found" },
      }),
    );

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId, channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("file_not_found");
    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toStrictEqual([]);
  });

  it("records a Slack upload for a run-scoped zero token", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: {
          fileId,
          channel: "C123",
          threadTs: "123.456",
          title: "Quarterly report",
          initialComment: "Uploaded from a run",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });

    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenLastCalledWith({
      files: [{ id: fileId, title: "Quarterly report" }],
      channel_id: "C123",
      thread_ts: "123.456",
      initial_comment: "Uploaded from a run",
    });

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: fileId,
      filename: "Quarterly report",
      contentType: "text/csv",
      size: 42,
      url: `https://slack.example/files/${fileId}`,
    });
  });

  it("does not record a run association for ordinary clerk session auth", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId, channel: "C123", title: "Session upload" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toStrictEqual([]);
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const body = { fileId, channel: "C123", title: "Retry upload" };

    await accept(
      client.complete({ body, headers: { authorization: `Bearer ${token}` } }),
      [200],
    );
    await accept(
      client.complete({ body, headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toHaveLength(1);
  });
});
