import { createStore } from "ccstate";
import { describe, expect, it, beforeEach } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  countSlackOrgConnections$,
  deleteSlackConnectOrg$,
  findSlackOrgConnection$,
  seedSlackConnectOrg$,
  type SlackConnectFixture,
} from "./helpers/zero-slack-connect";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const CONNECT_PATH = "http://api.test/api/zero/slack/connect";

function connectUrl(params: {
  readonly workspaceId?: string;
  readonly slackUserId?: string;
  readonly channelId?: string;
  readonly threadTs?: string;
  readonly orgId?: string;
}): string {
  const url = new URL(CONNECT_PATH);
  if (params.workspaceId) {
    url.searchParams.set("w", params.workspaceId);
  }
  if (params.slackUserId) {
    url.searchParams.set("u", params.slackUserId);
  }
  if (params.channelId) {
    url.searchParams.set("c", params.channelId);
  }
  if (params.threadTs) {
    url.searchParams.set("t", params.threadTs);
  }
  if (params.orgId) {
    url.searchParams.set("orgId", params.orgId);
  }
  return url.toString();
}

async function requestConnect(
  url: string,
  headers?: HeadersInit,
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  const requestHeaders = headers ?? { cookie: "__session=opaque" };
  return await app.request(url, { method: "GET", headers: requestHeaders });
}

describe("GET /api/zero/slack/connect", () => {
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "mock.ts",
      channel: "D_TEST",
    });
    context.mocks.slack.chat.postEphemeral.mockResolvedValue({
      ok: true,
      message_ts: "mock.ephemeral.ts",
    });
  });

  it("redirects unauthenticated users to sign-in with redirect_url", async () => {
    const response = await requestConnect(CONNECT_PATH, {});

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(CONNECT_PATH);
  });

  it("redirects invalid connect links to the Slack connect error page", async () => {
    mocks.clerk.session("user_invalid", "org_invalid", "org:admin");

    const response = await requestConnect(CONNECT_PATH);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/slack/connect?error=");
    expect(decodeURIComponent(location ?? "")).toContain(
      "Invalid connect link.",
    );
  });

  it("binds an unbound workspace for an admin and creates one connection", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("status=connected");

    const connection = await store.set(
      findSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      },
      context.signal,
    );
    expect(connection).toMatchObject({
      vm0UserId: fixture.userId,
      slackWorkspaceId: fixture.slackWorkspaceId,
    });
  });

  it("redirects missing workspace installs to the legacy Slack connect error", async () => {
    mocks.clerk.session(
      "user_missing_workspace",
      "org_missing_workspace",
      "org:admin",
    );

    const response = await requestConnect(
      connectUrl({
        workspaceId: "T_MISSING_WORKSPACE",
        slackUserId: "U_MISSING_WORKSPACE",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/slack/connect?error=");
    expect(decodeURIComponent(location ?? "")).toContain("Workspace not found");
  });

  it("rejects a non-admin connecting an unbound workspace", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/slack/connect?error=");
    expect(decodeURIComponent(location ?? "")).toContain("admin");
  });

  it("keeps reconnecting the same Slack user idempotent", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const url = connectUrl({
      workspaceId: fixture.slackWorkspaceId,
      slackUserId: fixture.slackUserId,
    });

    const first = await requestConnect(url);
    const second = await requestConnect(url);

    expect(first.status).toBe(307);
    expect(first.headers.get("location")).toContain("status=connected");
    expect(second.status).toBe(307);
    expect(second.headers.get("location")).toContain("status=connected");
    await expect(
      store.set(
        countSlackOrgConnections$,
        fixture.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(1);
  });

  it("allows a member to connect to a bound workspace", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        orgId: fixture.orgId,
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("status=connected");
  });

  it("redirects org mismatch to the legacy organization error", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, "org_other", "org:admin");

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        orgId: "org_other",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/slack/connect?error=");
    expect(decodeURIComponent(location ?? "")).toContain("active organization");
  });

  it("sends an ephemeral notification when channel context is present", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        channelId: "C_TEST",
        threadTs: "123.456",
      }),
    );
    expect(response.status).toBe(307);

    await clearAllDetached();
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TEST",
        user: fixture.slackUserId,
        thread_ts: "123.456",
      }),
    );
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it("falls back to DM when ephemeral notification fails", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.slack.chat.postEphemeral.mockRejectedValueOnce(
      new Error("channel_not_found"),
    );

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        channelId: "C_TEST",
      }),
    );
    expect(response.status).toBe(307);

    await clearAllDetached();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: fixture.slackUserId }),
    );
  });

  it("sends a connect DM and welcome thread when no channel context is present", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      }),
    );
    expect(response.status).toBe(307);

    await clearAllDetached();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.chat.postMessage.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not send a pending prompt DM from the browser connect flow", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await requestConnect(
      connectUrl({
        workspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
        orgId: fixture.orgId,
      }),
    );
    expect(response.status).toBe(307);

    await clearAllDetached();
    const promptCall = context.mocks.slack.chat.postMessage.mock.calls.find(
      ([message]) => {
        return (
          typeof message === "object" &&
          message !== null &&
          "text" in message &&
          typeof message.text === "string" &&
          message.text.includes("would you like me to run")
        );
      },
    );
    expect(promptCall).toBeUndefined();
  });
});
