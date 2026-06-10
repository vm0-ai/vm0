import { createStore } from "ccstate";
import { describe, expect, it, beforeEach } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
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

// BDD migration of the legacy
// `zero-slack-browser-connect.test.ts`. The 12 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) auth + link
// validation chain (307 redirects unauthenticated users
// to sign-in → 307 redirects invalid connect links → 307
// redirects missing workspace installs to the legacy
// error page), (2) admin bind + idempotency chain (307
// admin binds an unbound workspace + creates one
// connection → 307 keeps reconnecting idempotent → 307
// rejects non-admin connecting an unbound workspace),
// (3) member + notifications chain (307 member connects
// to a bound workspace → 307 org mismatch redirects to
// legacy organization error → 307 sends ephemeral
// notification when channel context is present → 307
// falls back to DM when ephemeral fails → 307 sends DM
// and welcome thread without channel context → 307 does
// not send pending prompt DM from the browser connect
// flow).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const CONNECT_PATH = "http://api.test/api/zero/slack/connect";
const APP_ORIGIN = "https://app.vm0.test";

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

describe("BDD GET /api/zero/slack/connect — auth + link validation chain", () => {
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("APP_URL", APP_ORIGIN);
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

  it("gwt-wt-wt: 307 redirects unauthenticated users to sign-in → 307 redirects invalid connect links to the error page → 307 redirects missing workspace installs to the legacy error", async () => {
    // Given: no auth header.

    // When + Then: 307 — redirect to sign-in with
    // redirect_url preserved.
    const noAuth = await requestConnect(CONNECT_PATH, {});
    expect(noAuth.status).toBe(307);
    const noAuthLocation = noAuth.headers.get("location");
    expect(noAuthLocation).not.toBeNull();
    const noAuthUrl = new URL(noAuthLocation!);
    expect(noAuthUrl.pathname).toBe("/sign-in");
    expect(noAuthUrl.searchParams.get("redirect_url")).toBe(CONNECT_PATH);

    // Given: an authenticated session with an invalid
    // connect link (missing workspace + slackUserId).
    mocks.clerk.session("user_invalid", "org_invalid", "org:admin");

    // When + Then: 307 — redirect to the Slack connect
    // error page.
    const invalidLink = await requestConnect(CONNECT_PATH);
    expect(invalidLink.status).toBe(307);
    const invalidLocation = invalidLink.headers.get("location");
    expect(invalidLocation).toContain(`${APP_ORIGIN}/settings/slack?error=`);
    expect(decodeURIComponent(invalidLocation ?? "")).toContain(
      "Invalid connect link.",
    );

    // Given: a session for a workspace that was never
    // installed.
    mocks.clerk.session(
      "user_missing_workspace",
      "org_missing_workspace",
      "org:admin",
    );

    // When + Then: 307 — redirect with "Workspace not
    // found".
    const missing = await requestConnect(
      connectUrl({
        workspaceId: "T_MISSING_WORKSPACE",
        slackUserId: "U_MISSING_WORKSPACE",
      }),
    );
    expect(missing.status).toBe(307);
    const missingLocation = missing.headers.get("location");
    expect(missingLocation).toContain(`${APP_ORIGIN}/settings/slack?error=`);
    expect(decodeURIComponent(missingLocation ?? "")).toContain(
      "Workspace not found",
    );

    // Suppress unused warning for the track fixture (it
    // is used by other chains in this describe family).
    void track;
  });
});

describe("BDD GET /api/zero/slack/connect — admin bind + idempotency chain", () => {
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("APP_URL", APP_ORIGIN);
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

  it("gwt-wt-wt: 307 admin binds an unbound workspace + creates one connection → 307 keeps reconnecting idempotent → 307 rejects non-admin connecting an unbound workspace", async () => {
    // Given: an admin session for a fresh unbound
    // workspace.
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

    // When + Then: 307 — admin binds the unbound
    // workspace and a connection row is created.
    const first = await requestConnect(url);
    expect(first.status).toBe(307);
    expect(first.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/slack?status=connected`,
    );
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

    // Given: the same admin session and the same connect
    // URL.

    // When + Then: 307 — reconnecting the same Slack user
    // is idempotent (count remains 1).
    const second = await requestConnect(url);
    expect(second.status).toBe(307);
    expect(second.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/slack?status=connected`,
    );
    await expect(
      store.set(
        countSlackOrgConnections$,
        fixture.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(1);

    // Given: a non-admin session for a fresh unbound
    // workspace.
    const nonAdminFixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(
      nonAdminFixture.userId,
      nonAdminFixture.orgId,
      "org:member",
    );

    // When + Then: 307 — non-admin is rejected.
    const nonAdminResponse = await requestConnect(
      connectUrl({
        workspaceId: nonAdminFixture.slackWorkspaceId,
        slackUserId: nonAdminFixture.slackUserId,
      }),
    );
    expect(nonAdminResponse.status).toBe(307);
    const nonAdminLocation = nonAdminResponse.headers.get("location");
    expect(nonAdminLocation).toContain(`${APP_ORIGIN}/settings/slack?error=`);
    expect(decodeURIComponent(nonAdminLocation ?? "")).toContain("admin");
  });
});

describe("BDD GET /api/zero/slack/connect — member + notifications chain", () => {
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("APP_URL", APP_ORIGIN);
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

  it("gwt-wt-wt: 307 member connects to a bound workspace → 307 org mismatch redirects to legacy organization error → 307 sends ephemeral notification when channel context is present → 307 falls back to DM when ephemeral fails → 307 sends DM + welcome thread without channel context → 307 does not send pending prompt DM from the browser connect flow", async () => {
    // Given: a member session for a bound workspace.
    const memberFixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(
      memberFixture.userId,
      memberFixture.orgId,
      "org:member",
    );

    // When + Then: 307 — member connects to a bound
    // workspace.
    const memberResponse = await requestConnect(
      connectUrl({
        workspaceId: memberFixture.slackWorkspaceId,
        slackUserId: memberFixture.slackUserId,
        orgId: memberFixture.orgId,
      }),
    );
    expect(memberResponse.status).toBe(307);
    expect(memberResponse.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/slack?status=connected`,
    );

    // Given: an admin session for an org that does not
    // match the bound workspace's orgId.
    const mismatchFixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(mismatchFixture.userId, "org_other", "org:admin");

    // When + Then: 307 — redirect to the legacy
    // organization error.
    const mismatchResponse = await requestConnect(
      connectUrl({
        workspaceId: mismatchFixture.slackWorkspaceId,
        slackUserId: mismatchFixture.slackUserId,
        orgId: "org_other",
      }),
    );
    expect(mismatchResponse.status).toBe(307);
    const mismatchLocation = mismatchResponse.headers.get("location");
    expect(mismatchLocation).toContain(`${APP_ORIGIN}/settings/slack?error=`);
    expect(decodeURIComponent(mismatchLocation ?? "")).toContain(
      "active organization",
    );

    // Given: an admin session for a fresh unbound
    // workspace + channel context.
    const ephemeralFixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(
      ephemeralFixture.userId,
      ephemeralFixture.orgId,
      "org:admin",
    );
    // Reset the postMessage mock so we can assert it
    // was not called for the ephemeral-success path.
    context.mocks.slack.chat.postMessage.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();

    // When + Then: 307 — ephemeral notification is sent
    // with channel + thread context + postMessage is not
    // called.
    const ephemeralResponse = await requestConnect(
      connectUrl({
        workspaceId: ephemeralFixture.slackWorkspaceId,
        slackUserId: ephemeralFixture.slackUserId,
        channelId: "C_TEST",
        threadTs: "123.456",
      }),
    );
    expect(ephemeralResponse.status).toBe(307);
    await clearAllDetached();
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TEST",
        user: ephemeralFixture.slackUserId,
        thread_ts: "123.456",
      }),
    );
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();

    // Given: an admin session for a fresh unbound
    // workspace + channel context where ephemeral fails.
    const fallbackFixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(
      fallbackFixture.userId,
      fallbackFixture.orgId,
      "org:admin",
    );
    context.mocks.slack.chat.postEphemeral.mockRejectedValueOnce(
      new Error("channel_not_found"),
    );
    context.mocks.slack.chat.postMessage.mockClear();

    // When + Then: 307 — falls back to DM.
    const fallbackResponse = await requestConnect(
      connectUrl({
        workspaceId: fallbackFixture.slackWorkspaceId,
        slackUserId: fallbackFixture.slackUserId,
        channelId: "C_TEST",
      }),
    );
    expect(fallbackResponse.status).toBe(307);
    await clearAllDetached();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: fallbackFixture.slackUserId }),
    );

    // Given: an admin session for a fresh unbound
    // workspace without channel context.
    const dmFixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(dmFixture.userId, dmFixture.orgId, "org:admin");
    context.mocks.slack.chat.postEphemeral.mockClear();
    context.mocks.slack.chat.postMessage.mockClear();

    // When + Then: 307 — sends a connect DM + welcome
    // thread (no ephemeral).
    const dmResponse = await requestConnect(
      connectUrl({
        workspaceId: dmFixture.slackWorkspaceId,
        slackUserId: dmFixture.slackUserId,
      }),
    );
    expect(dmResponse.status).toBe(307);
    await clearAllDetached();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.chat.postMessage.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);

    // Given: an admin session for a workspace that
    // already has a connection.
    const noPromptFixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
    mocks.clerk.session(
      noPromptFixture.userId,
      noPromptFixture.orgId,
      "org:admin",
    );
    context.mocks.slack.chat.postMessage.mockClear();

    // When + Then: 307 — does not send a pending prompt
    // DM from the browser connect flow.
    const noPromptResponse = await requestConnect(
      connectUrl({
        workspaceId: noPromptFixture.slackWorkspaceId,
        slackUserId: noPromptFixture.slackUserId,
        orgId: noPromptFixture.orgId,
      }),
    );
    expect(noPromptResponse.status).toBe(307);
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
