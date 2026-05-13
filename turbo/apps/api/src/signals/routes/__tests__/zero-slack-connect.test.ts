import { randomUUID } from "node:crypto";

import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteSlackConnectOrg$,
  findArtifactStorage$,
  findSlackOrgConnection$,
  findSlackOrgInstallation$,
  seedSlackConnectOrg$,
  type SlackConnectFixture,
} from "./helpers/zero-slack-connect";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const SLACK_CONNECT_PATH = "/api/zero/integrations/slack/connect";

function userIdsFromClerkListArgs(args: unknown): readonly string[] {
  if (typeof args !== "object" || args === null || !("userId" in args)) {
    return [];
  }
  const userId = args.userId;
  if (
    !Array.isArray(userId) ||
    !userId.every((candidate) => {
      return typeof candidate === "string";
    })
  ) {
    return [];
  }
  return userId;
}

function mockClerkUsersById(): void {
  context.mocks.clerk.users.getUserList.mockImplementation((args: unknown) => {
    return Promise.resolve({
      data: userIdsFromClerkListArgs(args).map((userId) => {
        return {
          id: userId,
          emailAddresses: [
            { id: `email_${userId}`, emailAddress: `${userId}@example.com` },
          ],
          primaryEmailAddressId: `email_${userId}`,
        };
      }),
    });
  });
}

async function postRawSlackConnect(body: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(SLACK_CONNECT_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer clerk-session",
      "content-type": "application/json",
    },
    body,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function expectErrorCode(
  body: unknown,
  code: string,
): asserts body is { readonly error: { readonly message: string } } {
  expect(body).toMatchObject({ error: { code } });
}

describe("GET /api/zero/integrations/slack/connect", () => {
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns isConnected: false when the user has no slack connection", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
    });
  });

  it("returns isConnected: true with workspace info when the user is connected", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { withConnection: true, slackWorkspaceName: "Test Workspace" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: "Test Workspace",
      defaultAgentName: null,
    });
  });

  it("returns isAdmin: true for admin users", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeTruthy();
  });

  it("returns isAdmin: false for member users", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeFalsy();
  });
});

describe("POST /api/zero/integrations/slack/connect", () => {
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
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
    mockClerkUsersById();
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.connect({
        headers: {},
        body: {
          workspaceId: "T-test",
          slackUserId: "U-test",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 400 when body is missing required fields", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await postRawSlackConnect("{}");

    expect(response.status).toBe(400);
    expectErrorCode(response.body, "BAD_REQUEST");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await postRawSlackConnect("not-json");

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid JSON in request body",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 404 when workspace does not exist", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: "T-nonexistent",
          slackUserId: fixture.slackUserId,
        },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Workspace not found. Please install the Slack app first.",
        code: "NOT_FOUND",
      },
    });
  });

  it("member connects successfully to a bound workspace", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );

    expect(response.body.role).toBe("member");
    const connection = await store.set(
      findSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      },
      context.signal,
    );
    expect(connection).toMatchObject({
      id: response.body.connectionId,
      vm0UserId: fixture.userId,
      slackWorkspaceId: fixture.slackWorkspaceId,
    });
  });

  it("admin connects successfully to a bound workspace", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );

    expect(response.body.role).toBe("admin");
  });

  it("creates artifact storage with an initial empty version after connect", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );
    await clearAllDetached();

    const artifactStorage = await store.set(
      findArtifactStorage$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    expect(artifactStorage).toMatchObject({
      s3Prefix: `${fixture.orgId}/artifact/artifact`,
      headVersionId: expect.any(String),
      versionId: expect.any(String),
    });
    expect(artifactStorage?.versionS3Key).toBe(
      `${fixture.orgId}/artifact/artifact/${artifactStorage?.versionId}`,
    );
    expect(context.mocks.s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-user-storages",
          Key: `${artifactStorage?.versionS3Key}/manifest.json`,
          ContentType: "application/json",
        }),
      }),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-user-storages",
          Key: `${artifactStorage?.versionS3Key}/archive.tar.gz`,
          ContentType: "application/gzip",
        }),
      }),
    );
  });

  it("sends an ephemeral Slack confirmation when channel context is provided", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
          channelId: "C_TEST_CHANNEL",
          threadTs: "1234567890.123456",
        },
      }),
      [200],
    );

    await clearAllDetached();

    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TEST_CHANNEL",
        user: fixture.slackUserId,
        text: "You're connected!",
        thread_ts: "1234567890.123456",
      }),
    );
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: fixture.slackUserId,
        view: expect.objectContaining({
          type: "home",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "section",
              text: expect.objectContaining({
                text: expect.stringContaining("*Connected to Zero*"),
              }),
            }),
          ]),
        }),
      }),
    );

    const connection = await store.set(
      findSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      },
      context.signal,
    );
    expect(connection?.dmWelcomeSent).toBeFalsy();
  });

  it("sends a DM welcome when no channel context is provided", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );

    await clearAllDetached();

    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(context.mocks.slack.chat.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: fixture.slackUserId,
        text: "You're connected!",
      }),
    );
    expect(context.mocks.slack.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: fixture.slackUserId,
        text: "Hi! I'm Zero.",
        thread_ts: "mock.ts",
      }),
    );

    const connection = await store.set(
      findSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      },
      context.signal,
    );
    expect(connection?.dmWelcomeSent).toBeTruthy();
  });

  it("falls back to DM welcome when ephemeral Slack confirmation fails", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.slack.chat.postEphemeral.mockRejectedValueOnce(
      Object.assign(new Error("not_in_channel"), {
        data: { ok: false, error: "not_in_channel" },
      }),
    );

    const client = setupApp({ context })(zeroSlackConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
          channelId: "C_TEST_CHANNEL",
        },
      }),
      [200],
    );

    await clearAllDetached();

    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TEST_CHANNEL",
        user: fixture.slackUserId,
      }),
    );
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledTimes(2);

    const connection = await store.set(
      findSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      },
      context.signal,
    );
    expect(connection?.dmWelcomeSent).toBeTruthy();
  });

  it("admin connects to an unbound workspace (binds it)", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );

    expect(response.body.role).toBe("admin");
    const installation = await store.set(
      findSlackOrgInstallation$,
      fixture.slackWorkspaceId,
      context.signal,
    );
    expect(installation?.orgId).toBe(fixture.orgId);
    expect(installation?.installedByUserId).toBe(fixture.userId);
  });

  it("returns 403 when non-admin tries to connect unbound workspace", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("Only org admins");
  });

  it("returns 403 when workspace is bound to a different org", async () => {
    const targetOrgId = `org_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: targetOrgId },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    const connection = await store.set(
      findSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        slackUserId: fixture.slackUserId,
      },
      context.signal,
    );
    expect(connection).toBeUndefined();
  });

  it("returns 403 with switch-org message when user is member of target org but wrong active org", async () => {
    const targetOrgId = `org_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: targetOrgId },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [403],
    );

    expect(response.body.error.message).toContain(
      "switch to the correct organization",
    );
  });

  it("connect is idempotent - second connect returns success", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);
    const first = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );
    const second = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );

    expect(second.body).toMatchObject({
      success: true,
      role: "admin",
      connectionId: first.body.connectionId,
    });
  });
});
