import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "vitest";
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
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-integrations-slack-message.test.ts`. The 13
// legacy `it()`s collapse into 4 BDD `it()`s:
// (1) auth + not-found chain (401 unauth → 401 no org
// membership → 403 sandbox without slack:write → 404 no
// Slack installation),
// (2) send + DM chain (200 sends to channel + 400 forwards
// Slack API error + 200 sends DM via user field +
// conversations.open + 404 when conversations.open fails
// with user_not_found + 200 resolves "me" to current
// user's Slack ID + 404 when "me" used but no
// connection),
// (3) footer: agent-only chain (200 appends "Sent via
// Agent" footer when agent is resolvable from run),
// (4) footer: schedule + user attribution chain (200
// appends schedule + creator + model in footer for
// schedule-triggered run + 200 appends user attribution
// footer for user-triggered run).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

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

const trackSlack = createFixtureTracker<SlackIntegrationFixture>((fixture) => {
  return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
});
const trackInsight = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});
const trackMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

async function seedBaseContext(): Promise<{
  readonly orgId: string;
  readonly userId: string;
}> {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = `user_${randomUUID().slice(0, 8)}`;
  await trackMembership(
    store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    ),
  );
  await trackInsight(Promise.resolve({ orgId, userId }));
  return { orgId, userId };
}

async function seedWithInstallation(): Promise<{
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
}> {
  const base = await seedBaseContext();
  const fixture = await trackSlack(
    store.set(seedSlackOrgInstallation$, { orgId: base.orgId }, context.signal),
  );
  return { ...base, slackWorkspaceId: fixture.slackWorkspaceId };
}

function client() {
  return setupApp({ context })(integrationsSlackMessageContract);
}

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

describe("BDD POST /api/zero/integrations/slack/message — auth + not-found chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no org membership → 403 sandbox without slack:write → 404 no Slack installation", async () => {
    // Given: no auth token.

    // When + Then: 401.
    const noAuth = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a Clerk user with no organization
    // membership + a zero token.

    // When + Then: 401.
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const noOrgToken = zeroToken({ userId, orgId, runId: "run-1" });
    const noOrgResponse = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${noOrgToken}` },
      }),
      [401],
    );
    expect(noOrgResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a sandbox token without slack:write.

    // When + Then: 403.
    const sandboxOrgId = `org_${randomUUID().slice(0, 8)}`;
    const sandboxUserId = `user_${randomUUID().slice(0, 8)}`;
    const sandboxRunId = `run_${randomUUID()}`;
    const sandboxTokenValue = sandboxToken({
      userId: sandboxUserId,
      orgId: sandboxOrgId,
      runId: sandboxRunId,
    });
    const sandboxResponse = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${sandboxTokenValue}` },
      }),
      [403],
    );
    expect(sandboxResponse.body.error.message).toContain("slack:write");

    // Given: a base context (org membership + insight
    // fixture) with no Slack installation.

    // When + Then: 404 — No Slack installation.
    const { orgId: noSlackOrgId, userId: noSlackUserId } =
      await seedBaseContext();
    const noSlackToken = zeroToken({
      userId: noSlackUserId,
      orgId: noSlackOrgId,
      runId: "run-1",
    });
    const noSlackResponse = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${noSlackToken}` },
      }),
      [404],
    );
    expect(noSlackResponse.body.error.message).toContain(
      "No Slack installation",
    );
  });
});

describe("BDD POST /api/zero/integrations/slack/message — send + DM chain", () => {
  it("gwt-wt-wt: 200 sends to channel → 400 forwards Slack API error → 200 sends DM via user + conversations.open → 404 conversations.open user_not_found → 200 resolves me to user's Slack ID → 404 me without connection", async () => {
    // Given: a base context with a Slack installation.

    // When + Then: 200 — chat.postMessage is called
    // with the expected channel + text + thread_ts.
    const simpleFixture = await seedWithInstallation();
    const simpleToken = zeroToken({
      userId: simpleFixture.userId,
      orgId: simpleFixture.orgId,
      runId: "run-1",
    });
    const simpleResponse = await accept(
      client().sendMessage({
        body: {
          channel: "C123456",
          text: "Hello from agent",
          threadTs: "1234567890.123456",
        },
        headers: { authorization: `Bearer ${simpleToken}` },
      }),
      [200],
    );
    expect(simpleResponse.body.ok).toBeTruthy();
    expect(simpleResponse.body.ts).toBe("mock.ts");
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C123456",
        text: "Hello from agent",
        thread_ts: "1234567890.123456",
      }),
    );

    // Given: a base context with a Slack installation +
    // a one-shot rejection on chat.postMessage with
    // channel_not_found.

    // When + Then: 400 — SLACK_ERROR with
    // channel_not_found.
    const errorFixture = await seedWithInstallation();
    const errorToken = zeroToken({
      userId: errorFixture.userId,
      orgId: errorFixture.orgId,
      runId: "run-1",
    });
    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );
    const errorResponse = await accept(
      client().sendMessage({
        body: { channel: "C-invalid", text: "hello" },
        headers: { authorization: `Bearer ${errorToken}` },
      }),
      [400],
    );
    expect(errorResponse.body.error.code).toBe("SLACK_ERROR");
    expect(errorResponse.body.error.message).toContain("channel_not_found");

    // Given: a base context with a Slack installation.

    // When + Then: 200 — conversations.open is called
    // with the user id + chat.postMessage is called with
    // the opened DM channel.
    const dmFixture = await seedWithInstallation();
    const dmToken = zeroToken({
      userId: dmFixture.userId,
      orgId: dmFixture.orgId,
      runId: "run-1",
    });
    const dmResponse = await accept(
      client().sendMessage({
        body: { user: "U0A8V9X98QJ", text: "Hello DM!" },
        headers: { authorization: `Bearer ${dmToken}` },
      }),
      [200],
    );
    expect(dmResponse.body.ok).toBeTruthy();
    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: "U0A8V9X98QJ",
    });
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "D-mock-dm",
        text: "Hello DM!",
      }),
    );

    // Given: a base context with a Slack installation +
    // a one-shot rejection on conversations.open with
    // user_not_found.

    // When + Then: 404 — NOT_FOUND with
    // user_not_found.
    const notFoundDmFixture = await seedWithInstallation();
    const notFoundDmToken = zeroToken({
      userId: notFoundDmFixture.userId,
      orgId: notFoundDmFixture.orgId,
      runId: "run-1",
    });
    context.mocks.slack.conversations.open.mockRejectedValueOnce(
      Object.assign(new Error("user_not_found"), {
        data: { ok: false, error: "user_not_found" },
      }),
    );
    const notFoundDmResponse = await accept(
      client().sendMessage({
        body: { user: "U-invalid", text: "hello" },
        headers: { authorization: `Bearer ${notFoundDmToken}` },
      }),
      [404],
    );
    expect(notFoundDmResponse.body.error.code).toBe("NOT_FOUND");
    expect(notFoundDmResponse.body.error.message).toContain("user_not_found");

    // Given: a base context with a Slack installation +
    // a Slack user connection for the current user.

    // When + Then: 200 — conversations.open is called
    // with the connected Slack user id.
    const meFixture = await seedWithInstallation();
    const { slackUserId } = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: meFixture.slackWorkspaceId,
        vm0UserId: meFixture.userId,
      },
      context.signal,
    );
    const meToken = zeroToken({
      userId: meFixture.userId,
      orgId: meFixture.orgId,
      runId: "run-1",
    });
    const meResponse = await accept(
      client().sendMessage({
        body: { user: "me", text: "Hello self!" },
        headers: { authorization: `Bearer ${meToken}` },
      }),
      [200],
    );
    expect(meResponse.body.ok).toBeTruthy();
    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: slackUserId,
    });

    // Given: a base context with a Slack installation
    // but no Slack user connection for the current
    // user + a "me" target.

    // When + Then: 404 — No Slack connection found.
    const noMeFixture = await seedWithInstallation();
    const noMeToken = zeroToken({
      userId: noMeFixture.userId,
      orgId: noMeFixture.orgId,
      runId: "run-1",
    });
    const noMeResponse = await accept(
      client().sendMessage({
        body: { user: "me", text: "hello" },
        headers: { authorization: `Bearer ${noMeToken}` },
      }),
      [404],
    );
    expect(noMeResponse.body.error.message).toContain(
      "No Slack connection found",
    );
  });
});

describe("BDD POST /api/zero/integrations/slack/message — agent-only footer chain", () => {
  it("gwt-wt-wt: 200 appends 'Sent via Agent' footer when agent is resolvable from run", async () => {
    // Given: a base context with a Slack installation +
    // a compose with a displayName + a run linked to
    // that compose.

    // When + Then: 200 — the message has 3 blocks +
    // the last context block contains "Sent via My
    // Assistant".
    const agentFixture = await seedWithInstallation();
    const { composeId } = await store.set(
      seedCompose$,
      {
        orgId: agentFixture.orgId,
        userId: agentFixture.userId,
        displayName: "My Assistant",
      },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      { orgId: agentFixture.orgId, userId: agentFixture.userId, composeId },
      context.signal,
    );
    const agentToken = zeroToken({
      userId: agentFixture.userId,
      orgId: agentFixture.orgId,
      runId,
    });
    const agentResponse = await accept(
      client().sendMessage({
        body: { channel: "C123456", text: "Hello" },
        headers: { authorization: `Bearer ${agentToken}` },
      }),
      [200],
    );
    expect(agentResponse.body.ok).toBeTruthy();
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
});

describe("BDD POST /api/zero/integrations/slack/message — schedule + user attribution footer chain", () => {
  it("gwt-wt-wt: 200 schedule-triggered run footer includes schedule + creator + model → 200 user-triggered run footer includes user attribution", async () => {
    // Given: a base context with a Slack installation +
    // a compose + a schedule + a schedule-triggered run
    // with a selectedModel + a Slack user connection.

    // When + Then: 200 — the footer context contains
    // "Sent via Agent · Triggered by schedule ... ·
    // Created by <@slackUserId> · Claude Sonnet 4.6".
    const scheduleFixture = await seedWithInstallation();
    const { composeId, agentId } = await store.set(
      seedCompose$,
      {
        orgId: scheduleFixture.orgId,
        userId: scheduleFixture.userId,
        displayName: "My Assistant",
      },
      context.signal,
    );
    const scheduleId = await store.set(
      seedSchedule$,
      {
        orgId: scheduleFixture.orgId,
        userId: scheduleFixture.userId,
        agentId,
        name: "daily-standup",
        description: "Daily standup summary",
      },
      context.signal,
    );
    const { runId: scheduleRunId } = await store.set(
      seedRun$,
      {
        orgId: scheduleFixture.orgId,
        userId: scheduleFixture.userId,
        composeId,
        scheduleId,
        triggerSource: "schedule",
      },
      context.signal,
    );
    await setRunSelectedModel(scheduleRunId, "claude-sonnet-4-6");
    const { slackUserId } = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: scheduleFixture.slackWorkspaceId,
        vm0UserId: scheduleFixture.userId,
      },
      context.signal,
    );
    const scheduleToken = zeroToken({
      userId: scheduleFixture.userId,
      orgId: scheduleFixture.orgId,
      runId: scheduleRunId,
    });
    const scheduleResponse = await accept(
      client().sendMessage({
        body: { channel: "C123456", text: "Standup results" },
        headers: { authorization: `Bearer ${scheduleToken}` },
      }),
      [200],
    );
    expect(scheduleResponse.body.ok).toBeTruthy();
    const scheduleCall = context.mocks.slack.chat.postMessage.mock.calls.at(
      -1,
    )?.[0] as
      | undefined
      | {
          blocks: {
            type: string;
            elements?: { text: string }[];
          }[];
        };
    expect(scheduleCall?.blocks).toBeDefined();
    const scheduleBlocks = scheduleCall!.blocks;
    expect(scheduleBlocks).toHaveLength(3);
    const scheduleFooterCtx = scheduleBlocks[scheduleBlocks.length - 1]!;
    expect(scheduleFooterCtx.type).toBe("context");
    expect(scheduleFooterCtx.elements![0]!.text).toBe(
      `Sent via My Assistant · Triggered by schedule "Daily standup summary" · Created by <@${slackUserId}> · Claude Sonnet 4.6`,
    );

    // Given: a base context with a Slack installation +
    // a compose + a user-triggered run + a Slack user
    // connection.

    // When + Then: 200 — the footer context contains
    // "Sent via Agent · Triggered by <@slackUserId>".
    const userFixture = await seedWithInstallation();
    const { composeId: userComposeId } = await store.set(
      seedCompose$,
      {
        orgId: userFixture.orgId,
        userId: userFixture.userId,
        displayName: "My Assistant",
      },
      context.signal,
    );
    const { runId: userRunId } = await store.set(
      seedRun$,
      {
        orgId: userFixture.orgId,
        userId: userFixture.userId,
        composeId: userComposeId,
      },
      context.signal,
    );
    const { slackUserId: userSlackUserId } = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: userFixture.slackWorkspaceId,
        vm0UserId: userFixture.userId,
      },
      context.signal,
    );
    const userToken = zeroToken({
      userId: userFixture.userId,
      orgId: userFixture.orgId,
      runId: userRunId,
    });
    const userResponse = await accept(
      client().sendMessage({
        body: { channel: "C123456", text: "Hello" },
        headers: { authorization: `Bearer ${userToken}` },
      }),
      [200],
    );
    expect(userResponse.body.ok).toBeTruthy();
    const userCall = context.mocks.slack.chat.postMessage.mock.calls.at(
      -1,
    )?.[0] as
      | undefined
      | {
          blocks: {
            type: string;
            elements?: { text: string }[];
          }[];
        };
    expect(userCall?.blocks).toBeDefined();
    const userBlocks = userCall!.blocks;
    expect(userBlocks).toHaveLength(3);
    const userFooterCtx = userBlocks[userBlocks.length - 1]!;
    expect(userFooterCtx.type).toBe("context");
    expect(userFooterCtx.elements![0]!.text).toBe(
      `Sent via My Assistant · Triggered by <@${userSlackUserId}>`,
    );
  });
});
