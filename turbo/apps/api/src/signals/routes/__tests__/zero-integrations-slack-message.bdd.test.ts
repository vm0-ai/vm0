import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { integrationsSlackMessageContract } from "@vm0/api-contracts/contracts/integrations";
import {
  testSlackStateContract,
  type TestSlackStatePostResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface SeededSlackState {
  readonly teamId: string;
  readonly response: TestSlackStatePostResponse;
}

interface SlackState {
  readonly response: TestSlackStatePostResponse;
  readonly slackUserId: string;
}

function client() {
  return setupApp({ context })(integrationsSlackMessageContract);
}

function stateClient() {
  return setupApp({ context })(testSlackStateContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

function mockMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        createdAt: 1,
        organization: { id: orgId },
        role: "org:member",
      },
    ],
  });
}

function slackWriteHeaders(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string | null;
}): { readonly authorization: string } {
  mockMembership(args.userId, args.orgId);
  const token = zeroToken({
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    capabilities: ["slack:write"],
  });
  return { authorization: `Bearer ${token}` };
}

async function deleteDefaultAgent(args: {
  readonly agentId: string | null;
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  if (!args.agentId) {
    return;
  }

  mocks.clerk.session(args.userId, args.orgId, "org:admin");
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      params: { id: args.agentId },
      headers: { authorization: "Bearer clerk-session" },
    }),
    [204, 404, 409],
  );
}

async function cleanupSlackState(seed: SeededSlackState): Promise<void> {
  mockEnv("ENV", "development");
  await accept(
    stateClient().delete({ query: { team_id: seed.teamId } }),
    [200],
  );
  await deleteDefaultAgent({
    agentId: seed.response.default_agent_id,
    userId: seed.response.vm0_user_id,
    orgId: seed.response.org_id,
  });
}

const trackSlackState =
  createFixtureTracker<SeededSlackState>(cleanupSlackState);

async function seedSlackState(
  args: {
    readonly seedConnection?: boolean;
    readonly seedDefaultAgent?: boolean;
    readonly seedSlackRun?: boolean;
    readonly seedScheduledSlackRun?: boolean;
    readonly selectedModel?: string;
  } = {},
): Promise<SlackState> {
  mockEnv("ENV", "development");
  const id = suffix();
  const teamId = `T_MESSAGE_${id.toUpperCase()}`;
  const userId = `user_slack_message_${id}`;
  const orgId = `org_slack_message_${id}`;
  const slackUserId = `U_MESSAGE_${id.toUpperCase()}`;
  mockMembership(userId, orgId);

  const response = await accept(
    stateClient().post({
      body: {
        team_id: teamId,
        slack_user_id: slackUserId,
        workspace_name: "Slack Message Workspace",
        bot_user_id: "U_MESSAGE_BOT",
        seed_connection: args.seedConnection,
        seed_default_agent: args.seedDefaultAgent,
        seed_slack_run: args.seedSlackRun,
        seed_scheduled_slack_run: args.seedScheduledSlackRun,
        selected_model: args.selectedModel,
      },
    }),
    [200],
  );

  await trackSlackState(Promise.resolve({ teamId, response: response.body }));
  return { response: response.body, slackUserId };
}

describe("POST /api/zero/integrations/slack/message BDD", () => {
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

  it("requires authentication, Slack write capability, organization membership, and installation state", async () => {
    const unauthenticated = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    const noMembershipToken = zeroToken({
      userId: `user_${suffix()}`,
      orgId: `org_${suffix()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["slack:write"],
    });
    const noMembership = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${noMembershipToken}` },
      }),
      [401],
    );

    expect(noMembership.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const missingCapabilityToken = sandboxToken({
      userId: `user_${suffix()}`,
      orgId: `org_${suffix()}`,
      runId: `run_${randomUUID()}`,
    });
    const missingCapability = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: { authorization: `Bearer ${missingCapabilityToken}` },
      }),
      [403],
    );

    expect(missingCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: slack:write",
        code: "FORBIDDEN",
      },
    });

    const userId = `user_${suffix()}`;
    const orgId = `org_${suffix()}`;
    const missingInstallation = await accept(
      client().sendMessage({
        body: { channel: "C123", text: "hello" },
        headers: slackWriteHeaders({ userId, orgId }),
      }),
      [404],
    );

    expect(missingInstallation.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this organization",
        code: "NOT_FOUND",
      },
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it("validates target shape before calling Slack", async () => {
    const state = await seedSlackState();
    const headers = slackWriteHeaders({
      userId: state.response.vm0_user_id,
      orgId: state.response.org_id,
    });

    const bothTargets = await accept(
      client().sendMessage({
        body: { channel: "C123", user: "U123", text: "hello" },
        headers,
      }),
      [400],
    );

    expect(bothTargets.body.error.code).toBe("BAD_REQUEST");

    const noTarget = await accept(
      client().sendMessage({
        body: { text: "hello" },
        headers,
      }),
      [400],
    );

    expect(noTarget.body.error.code).toBe("BAD_REQUEST");
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.conversations.open).not.toHaveBeenCalled();
  });

  it("sends channel messages and maps Slack postMessage errors", async () => {
    const state = await seedSlackState();
    const headers = slackWriteHeaders({
      userId: state.response.vm0_user_id,
      orgId: state.response.org_id,
    });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Block text" } },
    ];

    const sent = await accept(
      client().sendMessage({
        body: {
          channel: "C123456",
          text: "Hello from agent",
          threadTs: "1234567890.123456",
          blocks,
        },
        headers,
      }),
      [200],
    );

    expect(sent.body).toStrictEqual({
      ok: true,
      ts: "mock.ts",
      channel: "C123456",
    });
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith({
      channel: "C123456",
      text: "Hello from agent",
      thread_ts: "1234567890.123456",
      blocks,
    });

    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );

    const slackError = await accept(
      client().sendMessage({
        body: { channel: "C-invalid", text: "hello" },
        headers,
      }),
      [400],
    );

    expect(slackError.body).toStrictEqual({
      error: {
        message: "Slack API error: channel_not_found",
        code: "SLACK_ERROR",
      },
    });
  });

  it("sends direct messages, resolves me to the connected Slack user, and handles DM failures", async () => {
    const connected = await seedSlackState({ seedConnection: true });
    const connectedHeaders = slackWriteHeaders({
      userId: connected.response.vm0_user_id,
      orgId: connected.response.org_id,
    });

    const explicitUser = await accept(
      client().sendMessage({
        body: { user: "U0A8V9X98QJ", text: "Hello DM!" },
        headers: connectedHeaders,
      }),
      [200],
    );

    expect(explicitUser.body.ok).toBeTruthy();
    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: "U0A8V9X98QJ",
    });
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith({
      channel: "D-mock-dm",
      text: "Hello DM!",
      thread_ts: undefined,
      blocks: undefined,
    });

    const selfDm = await accept(
      client().sendMessage({
        body: { user: "me", text: "Hello self!" },
        headers: connectedHeaders,
      }),
      [200],
    );

    expect(selfDm.body.ok).toBeTruthy();
    expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
      users: connected.slackUserId,
    });

    context.mocks.slack.conversations.open.mockRejectedValueOnce(
      Object.assign(new Error("user_not_found"), {
        data: { ok: false, error: "user_not_found" },
      }),
    );
    const openError = await accept(
      client().sendMessage({
        body: { user: "U-invalid", text: "hello" },
        headers: connectedHeaders,
      }),
      [404],
    );

    expect(openError.body).toStrictEqual({
      error: {
        message: "Cannot open DM: user_not_found",
        code: "NOT_FOUND",
      },
    });

    const disconnected = await seedSlackState();
    const disconnectedHeaders = slackWriteHeaders({
      userId: disconnected.response.vm0_user_id,
      orgId: disconnected.response.org_id,
    });
    const missingConnection = await accept(
      client().sendMessage({
        body: { user: "me", text: "hello" },
        headers: disconnectedHeaders,
      }),
      [404],
    );

    expect(missingConnection.body).toStrictEqual({
      error: {
        message:
          "No Slack connection found for current user. Connect your Slack account first.",
        code: "NOT_FOUND",
      },
    });
  });

  it("appends route-visible run footers to Slack channel messages", async () => {
    const state = await seedSlackState({
      seedConnection: true,
      seedDefaultAgent: true,
      seedSlackRun: true,
      seedScheduledSlackRun: true,
      selectedModel: "claude-sonnet-4-6",
    });
    const runId = state.response.slack_run_id;
    if (!runId) {
      throw new Error("Expected the Slack state route to seed a run");
    }
    const scheduledRunId = state.response.scheduled_slack_run_id;
    if (!scheduledRunId) {
      throw new Error("Expected the Slack state route to seed a scheduled run");
    }
    const runHeaders = slackWriteHeaders({
      userId: state.response.vm0_user_id,
      orgId: state.response.org_id,
      runId,
    });

    const sent = await accept(
      client().sendMessage({
        body: { channel: "C123456", text: "Hello" },
        headers: runHeaders,
      }),
      [200],
    );

    expect(sent.body.ok).toBeTruthy();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith({
      channel: "C123456",
      text: "Hello",
      thread_ts: undefined,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Hello" } },
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Sent via e2e-slack-agent · Triggered by <@${state.slackUserId}>`,
            },
          ],
        },
      ],
    });

    const scheduledHeaders = slackWriteHeaders({
      userId: state.response.vm0_user_id,
      orgId: state.response.org_id,
      runId: scheduledRunId,
    });
    const scheduled = await accept(
      client().sendMessage({
        body: { channel: "C123456", text: "Standup results" },
        headers: scheduledHeaders,
      }),
      [200],
    );

    expect(scheduled.body.ok).toBeTruthy();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenLastCalledWith({
      channel: "C123456",
      text: "Standup results",
      thread_ts: undefined,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Standup results" },
        },
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Sent via e2e-slack-agent · Triggered by schedule "Daily standup summary" · Created by <@${state.slackUserId}> · Claude Sonnet 4.6`,
            },
          ],
        },
      ],
    });
  });
});
