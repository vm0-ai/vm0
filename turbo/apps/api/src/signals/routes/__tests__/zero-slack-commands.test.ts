import { createHmac, randomBytes } from "node:crypto";

import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../external/time";
import { clearAllDetached } from "../../utils";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  countSlackWebhookConnections$,
  deleteSlackWebhookFixture$,
  seedSlackWebhookFixture$,
  setSlackWebhookUserSelectedModel$,
  type SlackWebhookFixture,
} from "./helpers/zero-slack-webhooks";

const context = testContext();
const store = createStore();
const SIGNING_SECRET = randomBytes(32).toString("hex");
const COMMAND_PATH = "/api/zero/slack/commands";

function configureSlackWebhookTest(): void {
  mockOptionalEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("VM0_WEB_URL", "https://app.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "1710000000.000000",
    channel: "C-test",
  });
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

function buildCommandBody(
  overrides: Partial<{
    readonly teamId: string;
    readonly userId: string;
    readonly channelId: string;
    readonly text: string;
    readonly triggerId: string;
  }> = {},
): string {
  return new URLSearchParams({
    token: "test-token",
    team_id: overrides.teamId ?? "T-test",
    team_domain: "test-workspace",
    channel_id: overrides.channelId ?? "C-test",
    channel_name: "general",
    user_id: overrides.userId ?? "U-test",
    user_name: "testuser",
    command: "/zero",
    text: overrides.text ?? "",
    response_url: "https://hooks.slack.com/commands/T-test/response",
    trigger_id: overrides.triggerId ?? "trigger-123",
    api_app_id: "A-test",
  }).toString();
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

async function postCommand(
  body: string,
  headers: Record<string, string> = signedHeaders(body),
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await createApp({ signal: context.signal }).request(
    COMMAND_PATH,
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

interface SlackSelectOption {
  readonly value: string;
  readonly text?: { readonly text?: string };
}

interface SlackSelectElement {
  readonly options?: readonly SlackSelectOption[];
  readonly initial_option?: SlackSelectOption;
}

interface SlackModalBlock {
  readonly element?: SlackSelectElement;
}

interface SlackModalView {
  readonly callback_id?: string;
  readonly private_metadata?: string;
  readonly blocks?: readonly SlackModalBlock[];
}

interface SlackViewOpenCall {
  readonly trigger_id?: string;
  readonly view?: SlackModalView;
}

function latestSlackViewOpenCall(): SlackViewOpenCall {
  const call = context.mocks.slack.views.open.mock.calls.at(-1)?.[0] as
    | SlackViewOpenCall
    | undefined;
  if (!call) {
    throw new Error("Expected Slack views.open to be called");
  }
  return call;
}

function getStaticSelectElement(view: SlackModalView): SlackSelectElement {
  const block = view.blocks?.find((candidate) => {
    return candidate.element?.options !== undefined;
  });
  if (!block?.element) {
    throw new Error("Expected Slack modal to include a static select element");
  }
  return block.element;
}

describe("POST /api/zero/slack/commands", () => {
  const track = createFixtureTracker<SlackWebhookFixture>((fixture) => {
    return store.set(deleteSlackWebhookFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    configureSlackWebhookTest();
  });

  it("returns 503 when Slack signing is not configured", async () => {
    mockOptionalEnv("SLACK_SIGNING_SECRET", undefined);

    const response = await postCommand(buildCommandBody({ text: "help" }), {
      "content-type": "application/x-www-form-urlencoded",
    });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "Slack integration is not configured",
    });
  });

  it("rejects missing and invalid Slack signatures", async () => {
    const body = buildCommandBody({ text: "help" });

    const missing = await postCommand(body, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(missing.status).toBe(401);
    expect(missing.body).toStrictEqual({
      error: "Missing Slack signature headers",
    });

    const invalid = await postCommand(body, {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": Math.floor(now() / 1000).toString(),
      "x-slack-signature": "v0=invalid",
    });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toStrictEqual({ error: "Invalid signature" });
  });

  it("returns help for empty, help, and unknown commands", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    for (const text of ["", "help", "unknown"]) {
      const response = await postCommand(
        buildCommandBody({
          teamId: fixture.slackWorkspaceId,
          userId: fixture.slackUserId,
          text,
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ response_type: "ephemeral" });
      expect(JSON.stringify(response.body)).toContain("Zero Slack Bot Help");
    }
  });

  it("handles connect states", async () => {
    const notInstalled = await postCommand(
      buildCommandBody({ teamId: "T-not-installed", text: "connect" }),
    );
    expect(notInstalled.status).toBe(200);
    expect(JSON.stringify(notInstalled.body)).toContain("hasn't been set up");

    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: false },
        context.signal,
      ),
    );
    const login = await postCommand(
      buildCommandBody({
        teamId: fixture.slackWorkspaceId,
        userId: fixture.slackUserId,
        text: "connect",
      }),
    );
    expect(login.status).toBe(200);
    expect(JSON.stringify(login.body)).toContain("Connect");

    const connected = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true },
        context.signal,
      ),
    );
    const alreadyConnected = await postCommand(
      buildCommandBody({
        teamId: connected.slackWorkspaceId,
        userId: connected.slackUserId,
        text: "connect",
      }),
    );
    expect(alreadyConnected.status).toBe(200);
    expect(JSON.stringify(alreadyConnected.body)).toContain(
      "already connected",
    );
  });

  it("disconnects the Slack user and refreshes App Home", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    const response = await postCommand(
      buildCommandBody({
        teamId: fixture.slackWorkspaceId,
        userId: fixture.slackUserId,
        text: "disconnect",
      }),
    );
    await clearAllDetached();

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

  it("returns a not-connected response when disconnecting without a connection", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: false },
        context.signal,
      ),
    );

    const response = await postCommand(
      buildCommandBody({
        teamId: fixture.slackWorkspaceId,
        userId: fixture.slackUserId,
        text: "disconnect",
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain("not connected");
    await expect(
      store.set(
        countSlackWebhookConnections$,
        fixture.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(0);
  });

  it("opens the switch picker with org default and non-default agent options", async () => {
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
    if (!fixture.defaultAgentId || !fixture.switchAgentId) {
      throw new Error("Expected Slack fixture to include switchable agents");
    }

    const switchResponse = await postCommand(
      buildCommandBody({
        teamId: fixture.slackWorkspaceId,
        userId: fixture.slackUserId,
        text: "switch",
      }),
    );

    expect(switchResponse.status).toBe(200);
    const call = latestSlackViewOpenCall();
    expect(call.trigger_id).toBe("trigger-123");
    expect(call.view?.callback_id).toBe("switch_agent_modal");
    expect(call.view?.private_metadata).toBe(
      JSON.stringify({ channelId: "C-test" }),
    );
    const select = getStaticSelectElement(call.view ?? {});
    const values =
      select.options?.map((option) => {
        return option.value;
      }) ?? [];
    const labels =
      select.options?.map((option) => {
        return option.text?.text;
      }) ?? [];

    expect(values).toContain("__org_default__");
    expect(values).toContain(fixture.switchAgentId);
    expect(values).not.toContain(fixture.defaultAgentId);
    expect(labels).toContainEqual(expect.stringContaining("Use org default"));
  });

  it("returns a login prompt for switch when the Slack user is not connected", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: false, withDefaultAgent: true },
        context.signal,
      ),
    );

    const response = await postCommand(
      buildCommandBody({
        teamId: fixture.slackWorkspaceId,
        userId: fixture.slackUserId,
        text: "switch",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ response_type: "ephemeral" });
    expect(JSON.stringify(response.body)).toContain("connect");
    expect(context.mocks.slack.views.open).not.toHaveBeenCalled();
  });

  it("opens the model picker with default, available models, and current selection", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        {
          withConnection: true,
          withDefaultAgent: true,
        },
        context.signal,
      ),
    );
    await store.set(
      setSlackWebhookUserSelectedModel$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        selectedModel: "deepseek-v4-pro",
      },
      context.signal,
    );

    const modelResponse = await postCommand(
      buildCommandBody({
        teamId: fixture.slackWorkspaceId,
        userId: fixture.slackUserId,
        text: "model",
      }),
    );

    expect(modelResponse.status).toBe(200);
    const call = latestSlackViewOpenCall();
    expect(call.trigger_id).toBe("trigger-123");
    expect(call.view?.callback_id).toBe("model_preference_modal");
    expect(call.view?.private_metadata).toBe(
      JSON.stringify({ channelId: "C-test" }),
    );
    const select = getStaticSelectElement(call.view ?? {});
    const values =
      select.options?.map((option) => {
        return option.value;
      }) ?? [];
    const labels =
      select.options?.map((option) => {
        return option.text?.text;
      }) ?? [];

    expect(values).toContain("claude-sonnet-4-6");
    expect(values).toContain("deepseek-v4-pro");
    expect(values).toContain("gpt-5.5");
    expect(labels).toContain("Claude Sonnet 4.6 (workspace default)");
    expect(select.initial_option?.value).toBe("deepseek-v4-pro");
  });

  it("advertises switch and model commands only when available", async () => {
    const unbound = await track(
      store.set(
        seedSlackWebhookFixture$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    const unboundHelp = await postCommand(
      buildCommandBody({
        teamId: unbound.slackWorkspaceId,
        userId: unbound.slackUserId,
        text: "help",
      }),
    );
    const unboundBody = JSON.stringify(unboundHelp.body);
    expect(unboundHelp.status).toBe(200);
    expect(unboundBody).not.toContain("/zero switch");
    expect(unboundBody).not.toContain("/zero model");
    expect(unboundBody).toContain("/zero connect");

    const connected = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    const connectedHelp = await postCommand(
      buildCommandBody({
        teamId: connected.slackWorkspaceId,
        userId: connected.slackUserId,
        text: "help",
      }),
    );
    const connectedBody = JSON.stringify(connectedHelp.body);
    expect(connectedHelp.status).toBe(200);
    expect(connectedBody).toContain("/zero switch");
    expect(connectedBody).toContain("/zero model");
  });
});
