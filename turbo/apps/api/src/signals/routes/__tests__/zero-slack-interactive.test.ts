import { createHmac, randomBytes } from "node:crypto";

import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../external/time";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  countSlackWebhookConnections$,
  deleteSlackWebhookFixture$,
  findSlackAgentPreference$,
  findUserSelectedModel$,
  seedSlackWebhookFixture$,
  type SlackWebhookFixture,
} from "./helpers/zero-slack-webhooks";

const context = testContext();
const store = createStore();
const SIGNING_SECRET = randomBytes(32).toString("hex");
const INTERACTIVE_PATH = "/api/zero/slack/interactive";

function configureSlackWebhookTest(): void {
  mockOptionalEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("VM0_WEB_URL", "https://app.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "1710000000.000001",
  });
  context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  context.mocks.slack.views.open.mockResolvedValue({
    ok: true,
    view: { id: "V-test" },
  });
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = Math.floor(now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

async function postInteractiveBody(
  body: string,
  headers: Record<string, string> = signedHeaders(body),
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await createApp({ signal: context.signal }).request(
    INTERACTIVE_PATH,
    {
      method: "POST",
      headers,
      body,
    },
  );
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: contentType.includes("application/json")
      ? await response.json()
      : await response.text(),
  };
}

function postInteractive(
  payload: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return postInteractiveBody(
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
  );
}

function agentPickerSubmission(args: {
  readonly workspaceId: string;
  readonly slackUserId: string;
  readonly selectedValue: string;
  readonly channelId?: string;
}): Record<string, unknown> {
  return {
    type: "view_submission",
    user: {
      id: args.slackUserId,
      username: "testuser",
      team_id: args.workspaceId,
    },
    team: { id: args.workspaceId, domain: "test" },
    view: {
      callback_id: "switch_agent_modal",
      ...(args.channelId && {
        private_metadata: JSON.stringify({ channelId: args.channelId }),
      }),
      state: {
        values: {
          agent_select_block: {
            agent_select: {
              selected_option: { value: args.selectedValue },
            },
          },
        },
      },
    },
  };
}

function modelPickerSubmission(args: {
  readonly workspaceId: string;
  readonly slackUserId: string;
  readonly selectedValue: string;
  readonly channelId?: string;
}): Record<string, unknown> {
  return {
    type: "view_submission",
    user: {
      id: args.slackUserId,
      username: "testuser",
      team_id: args.workspaceId,
    },
    team: { id: args.workspaceId, domain: "test" },
    view: {
      callback_id: "model_preference_modal",
      ...(args.channelId && {
        private_metadata: JSON.stringify({ channelId: args.channelId }),
      }),
      state: {
        values: {
          model_select_block: {
            model_select: {
              selected_option: { value: args.selectedValue },
            },
          },
        },
      },
    },
  };
}

describe("POST /api/zero/slack/interactive", () => {
  const track = createFixtureTracker<SlackWebhookFixture>((fixture) => {
    return store.set(deleteSlackWebhookFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    configureSlackWebhookTest();
  });

  it("rejects missing Slack signatures and missing payloads", async () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({ type: "block_actions" }),
    }).toString();
    const missingSignature = await postInteractiveBody(body, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(missingSignature.status).toBe(401);
    expect(missingSignature.body).toStrictEqual({
      error: "Missing Slack signature headers",
    });

    const missingPayload = await postInteractiveBody("foo=bar");
    expect(missingPayload.status).toBe(400);
    expect(missingPayload.body).toStrictEqual({ error: "Missing payload" });
  });

  it("returns an empty 200 response for empty block actions", async () => {
    const response = await postInteractive({
      type: "block_actions",
      user: { id: "U-test", username: "testuser", team_id: "T-test" },
      team: { id: "T-test", domain: "test" },
      actions: [],
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("");
  });

  it("disconnects from App Home and refreshes the view", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    const response = await postInteractive({
      type: "block_actions",
      user: {
        id: fixture.slackUserId,
        username: "testuser",
        team_id: fixture.slackWorkspaceId,
      },
      team: { id: fixture.slackWorkspaceId, domain: "test" },
      actions: [{ action_id: "home_disconnect", block_id: "home" }],
    });

    expect(response.status).toBe(200);
    await expect(
      store.set(
        countSlackWebhookConnections$,
        fixture.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(0);
    expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();
  });

  it("persists the selected agent and rejects agents from other orgs", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        {
          withConnection: true,
          withDefaultAgent: true,
          withSwitchAgent: true,
        },
        context.signal,
      ),
    );
    expect(fixture.switchAgentId).toBeTruthy();

    const response = await postInteractive(
      agentPickerSubmission({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        selectedValue: fixture.switchAgentId ?? "",
        channelId: "C-test",
      }),
    );

    expect(response.status).toBe(200);
    await expect(
      store.set(
        findSlackAgentPreference$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      ),
    ).resolves.toBe(fixture.switchAgentId);
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        user: fixture.slackUserId,
      }),
    );

    const other = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    expect(other.defaultAgentId).toBeTruthy();

    const rejected = await postInteractive(
      agentPickerSubmission({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        selectedValue: other.defaultAgentId ?? "",
      }),
    );

    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      response_action: "errors",
      errors: {
        agent_select_block: "You don't have access to that agent.",
      },
    });
  });

  it("persists the selected agent when channel confirmation fails", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        {
          withConnection: true,
          withDefaultAgent: true,
          withSwitchAgent: true,
        },
        context.signal,
      ),
    );
    expect(fixture.switchAgentId).toBeTruthy();
    context.mocks.slack.chat.postEphemeral.mockRejectedValueOnce(
      new Error("ephemeral failed"),
    );

    const response = await postInteractive(
      agentPickerSubmission({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        selectedValue: fixture.switchAgentId ?? "",
        channelId: "C-test",
      }),
    );

    expect(response.status).toBe(200);
    await expect(
      store.set(
        findSlackAgentPreference$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      ),
    ).resolves.toBe(fixture.switchAgentId);
  });

  it("persists the selected model and opens the home switch modal", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        {
          withConnection: true,
          withDefaultAgent: true,
          withSwitchAgent: true,
        },
        context.signal,
      ),
    );

    const modelResponse = await postInteractive(
      modelPickerSubmission({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        selectedValue: "claude-sonnet-4-6",
        channelId: "C-test",
      }),
    );

    expect(modelResponse.status).toBe(200);
    await expect(
      store.set(
        findUserSelectedModel$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      ),
    ).resolves.toBe("claude-sonnet-4-6");

    const switchResponse = await postInteractive({
      type: "block_actions",
      user: {
        id: fixture.slackUserId,
        username: "testuser",
        team_id: fixture.slackWorkspaceId,
      },
      team: { id: fixture.slackWorkspaceId, domain: "test" },
      trigger_id: "trigger-123",
      actions: [{ action_id: "home_switch_agent", block_id: "home" }],
    });

    expect(switchResponse.status).toBe(200);
    expect(context.mocks.slack.views.open).toHaveBeenCalledOnce();
  });
});
