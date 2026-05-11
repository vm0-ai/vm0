import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { integrationsSlackMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedSchedule$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

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

async function setRunSelectedModel(
  runId: string,
  selectedModel: string,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(zeroRuns)
    .set({ selectedModel })
    .where(eq(zeroRuns.id, runId));
}

describe("POST /api/zero/integrations/slack/message", () => {
  const slackFixtures: SlackIntegrationFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];
  const insightFixtures: UsageInsightFixture[] = [];

  beforeEach(() => {
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "mock.ts",
      channel: "C123456",
    });
    context.mocks.slack.conversations.open.mockResolvedValue({
      ok: true,
      channel: { id: "D-mock-dm" },
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
    slackWorkspaceId: string;
  }> {
    const base = await seedBaseContext();
    const fixture = await store.set(
      seedSlackOrgInstallation$,
      { orgId: base.orgId },
      context.signal,
    );
    slackFixtures.push(fixture);
    return { ...base, slackWorkspaceId: fixture.slackWorkspaceId };
  }

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123", text: "hello" },
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

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:write");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const { orgId, userId } = await seedBaseContext();
    const token = zeroToken({ userId, orgId, runId: "run-1" });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack installation");
  });

  it("sends message successfully and returns Slack response", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: "run-1" });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          channel: "C123456",
          text: "Hello from agent",
          threadTs: "1234567890.123456",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();
    expect(response.body.ts).toBe("mock.ts");

    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C123456",
        text: "Hello from agent",
        thread_ts: "1234567890.123456",
      }),
    );
  });

  it("forwards Slack API error with 400 status", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: "run-1" });

    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C-invalid", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("channel_not_found");
  });

  it("sends DM via user field using conversations.open", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: "run-1" });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "U0A8V9X98QJ", text: "Hello DM!" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: "U0A8V9X98QJ",
    });
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "D-mock-dm",
        text: "Hello DM!",
      }),
    );
  });

  it("returns 404 when conversations.open fails with user_not_found", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: "run-1" });

    context.mocks.slack.conversations.open.mockRejectedValueOnce(
      Object.assign(new Error("user_not_found"), {
        data: { ok: false, error: "user_not_found" },
      }),
    );

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "U-invalid", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toContain("user_not_found");
  });

  it("resolves 'me' to current user's Slack ID and sends DM", async () => {
    const { orgId, userId, slackWorkspaceId } = await seedWithInstallation();
    const { slackUserId } = await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    const token = zeroToken({ userId, orgId, runId: "run-1" });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "me", text: "Hello self!" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: slackUserId,
    });
  });

  it("returns 404 when 'me' is used but no Slack connection exists", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: "run-1" });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { user: "me", text: "hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack connection found");
  });

  it("appends 'Sent via' footer when agent is resolvable from run", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const { composeId } = await store.set(
      seedCompose$,
      { orgId, userId, displayName: "My Assistant" },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      { orgId, userId, composeId },
      context.signal,
    );
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123456", text: "Hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    const call = context.mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0] as
      | undefined
      | {
          blocks: {
            type: string;
            text?: { text: string };
            elements?: { text: string }[];
          }[];
        };
    expect(call?.blocks).toBeDefined();
    const blocks = call!.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe("section");
    expect(blocks[0]!.text!.text).toBe("Hello");
    expect(blocks[blocks.length - 2]!.type).toBe("divider");
    const footerCtx = blocks[blocks.length - 1]!;
    expect(footerCtx.type).toBe("context");
    expect(footerCtx.elements![0]!.text).toBe("Sent via My Assistant");
  });

  it("appends schedule, creator, and model in footer when run is triggered by a schedule", async () => {
    const { orgId, userId, slackWorkspaceId } = await seedWithInstallation();
    const { composeId, agentId } = await store.set(
      seedCompose$,
      { orgId, userId, displayName: "My Assistant" },
      context.signal,
    );
    const scheduleId = await store.set(
      seedSchedule$,
      {
        orgId,
        userId,
        agentId,
        name: "daily-standup",
        description: "Daily standup summary",
      },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId,
        userId,
        composeId,
        scheduleId,
        triggerSource: "schedule",
      },
      context.signal,
    );
    await setRunSelectedModel(runId, "claude-sonnet-4-6");

    const { slackUserId } = await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );

    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123456", text: "Standup results" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    const call = context.mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0] as
      | undefined
      | {
          blocks: {
            type: string;
            elements?: { text: string }[];
          }[];
        };
    expect(call?.blocks).toBeDefined();
    const blocks = call!.blocks;
    expect(blocks).toHaveLength(3);

    const footerCtx = blocks[blocks.length - 1]!;
    expect(footerCtx.type).toBe("context");
    expect(footerCtx.elements![0]!.text).toBe(
      `Sent via My Assistant · Triggered by schedule "Daily standup summary" · Created by <@${slackUserId}> · Claude Sonnet 4.6`,
    );
  });

  it("appends user attribution footer when run is user-triggered (not scheduled)", async () => {
    const { orgId, userId, slackWorkspaceId } = await seedWithInstallation();
    const { composeId } = await store.set(
      seedCompose$,
      { orgId, userId, displayName: "My Assistant" },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      { orgId, userId, composeId },
      context.signal,
    );

    const { slackUserId } = await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );

    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(integrationsSlackMessageContract);
    const response = await accept(
      client.sendMessage({
        body: { channel: "C123456", text: "Hello" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    const call = context.mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0] as
      | undefined
      | {
          blocks: {
            type: string;
            elements?: { text: string }[];
          }[];
        };
    expect(call?.blocks).toBeDefined();
    const blocks = call!.blocks;
    expect(blocks).toHaveLength(3);

    const footerCtx = blocks[blocks.length - 1]!;
    expect(footerCtx.type).toBe("context");
    expect(footerCtx.elements![0]!.text).toBe(
      `Sent via My Assistant · Triggered by <@${slackUserId}>`,
    );
  });
});
