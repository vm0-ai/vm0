import { randomUUID } from "node:crypto";

import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const integrations = createBddIntegrationApi(context);

const SLACK_CONVERSATIONS_URL = "https://slack.com/api/conversations.list";
const REQUIRED_SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
] as const;
const STORED_CHANNEL = { id: "C_PRODUCT", name: "product" } as const;

interface SlackConversationFixture {
  readonly id: string;
  readonly name: string;
  readonly isMember?: boolean;
  readonly isArchived?: boolean;
}

interface SlackAutomationFixture {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly enabled: boolean;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" } as const;
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function authenticate(actor: ApiTestUser, orgId: string): void {
  mocks.clerk.session(actor.userId, orgId, actor.orgRole);
}

function configureSlackConversations(
  channels: readonly SlackConversationFixture[],
): void {
  server.use(
    http.get(SLACK_CONVERSATIONS_URL, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("types")).toBe(
        "public_channel,private_channel",
      );
      expect(url.searchParams.get("exclude_archived")).toBe("true");
      return HttpResponse.json({
        ok: true,
        channels: channels.map((channel) => {
          return {
            id: channel.id,
            name: channel.name,
            is_member: channel.isMember ?? true,
            is_archived: channel.isArchived ?? false,
          };
        }),
        response_metadata: { next_cursor: "" },
      });
    }),
  );
}

async function setSlackFeature(
  fixture: Pick<SlackAutomationFixture, "actor" | "orgId">,
  enabled: boolean,
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    { orgId: fixture.orgId, userId: fixture.actor.userId },
    { [FeatureSwitchKey.SlackUserMentionAutomations]: enabled },
  );
  authenticate(fixture.actor, fixture.orgId);
}

async function setupSlackAutomation(
  options: {
    readonly enabled?: boolean;
    readonly visibility?: "public" | "private";
  } = {},
): Promise<SlackAutomationFixture> {
  const { actor } = await workflows.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const visibility = options.visibility ?? "public";
  const agent = await workflows.createAgent(actor, {
    displayName: "Slack readiness agent",
    visibility,
  });
  const workflowId = await workflows.createWorkflow(actor, {
    agentId: agent.agentId,
    name: `slack-readiness-${randomUUID()}`,
    visibility,
  });
  const fixtureBase = { actor, orgId: actor.orgId };
  await setSlackFeature(fixtureBase, true);
  integrations.configureSlackAppMocks();
  await integrations.installSlackWorkspace(actor, {
    botScopes: REQUIRED_SLACK_BOT_SCOPES,
  });
  configureSlackConversations([STORED_CHANNEL]);
  authenticate(actor, actor.orgId);

  const enabled = options.enabled ?? true;
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: {
        kind: "event",
        eventType: "slack-user-mentioned",
        eventConfig: {
          provider: "slack",
          event: "user_mentioned",
          channel: STORED_CHANNEL.name,
        },
        enabled,
      },
    }),
    [201],
  );
  return {
    actor,
    orgId: actor.orgId,
    workflowId,
    automationId: created.body.id,
    enabled,
  };
}

function caller(
  fixture: SlackAutomationFixture,
  role: "org:admin" | "org:member",
): ApiTestUser {
  return workflows.user({ orgId: fixture.orgId, orgRole: role });
}

async function readSlackReadiness(
  fixture: SlackAutomationFixture,
  actor: ApiTestUser,
) {
  authenticate(actor, fixture.orgId);
  return await accept(
    automationsClient().getSlackReadiness({
      headers: authHeaders(),
      params: { id: fixture.automationId },
    }),
    [200],
  );
}

async function expectAutomationUnchanged(
  fixture: SlackAutomationFixture,
): Promise<void> {
  authenticate(fixture.actor, fixture.orgId);
  const automation = await accept(
    automationsClient().get({
      headers: authHeaders(),
      params: { id: fixture.automationId },
    }),
    [200],
  );
  expect(automation.body).toMatchObject({
    ownerUserId: fixture.actor.userId,
    enabled: fixture.enabled,
    eventType: "slack-user-mentioned",
    eventConfig: { channel: STORED_CHANNEL },
  });
}

describe("GET /api/zero/workflow-automations/:id/slack-readiness", () => {
  it("evaluates the owner and stored channel ID without mutating a disabled automation", async () => {
    const fixture = await setupSlackAutomation({ enabled: false });
    const visibleMember = caller(fixture, "org:member");
    configureSlackConversations([
      { id: STORED_CHANNEL.id, name: "renamed-product" },
    ]);

    const readiness = await readSlackReadiness(fixture, visibleMember);
    expect(readiness.body).toStrictEqual({
      eventType: "slack-user-mentioned",
      status: "ready",
      reason: null,
      message: "Slack is ready for this automation.",
      action: null,
    });

    await expectAutomationUnchanged(fixture);
  });

  it("keeps a gated-off record readable without calling it ready", async () => {
    const fixture = await setupSlackAutomation({ enabled: false });
    await setSlackFeature(fixture, false);

    const readiness = await readSlackReadiness(fixture, fixture.actor);
    expect(readiness.body).toStrictEqual({
      eventType: "slack-user-mentioned",
      status: "unavailable",
      reason: "feature-disabled",
      message: "Slack user-mentioned automations are not enabled.",
      action: null,
    });

    await expectAutomationUnchanged(fixture);
  });

  it("offers installation only to the current caller when that caller is an admin", async () => {
    const fixture = await setupSlackAutomation();
    await integrations.requestSlackDisconnect(
      fixture.actor,
      "uninstall",
      [200],
    );
    const member = caller(fixture, "org:member");
    const admin = caller(fixture, "org:admin");

    const memberReadiness = await readSlackReadiness(fixture, member);
    expect(memberReadiness.body).toStrictEqual({
      eventType: "slack-user-mentioned",
      status: "setup-required",
      reason: "not-installed",
      message: "Install the Zero Slack App before this automation can run.",
      action: null,
    });

    const adminReadiness = await readSlackReadiness(fixture, admin);
    expect(adminReadiness.body).toMatchObject({
      status: "setup-required",
      reason: "not-installed",
      action: { kind: "install", label: "Install Slack" },
    });
    expect(adminReadiness.body.message).toBe(memberReadiness.body.message);
    if (adminReadiness.body.action?.kind !== "install") {
      throw new Error("Expected an admin-only install action");
    }
    const actionUrl = new URL(adminReadiness.body.action.url);
    expect(actionUrl.searchParams.get("orgId")).toBe(fixture.orgId);
    expect(actionUrl.searchParams.get("vm0UserId")).toBe(admin.userId);

    await integrations.installSlackWorkspace(fixture.actor, {
      botScopes: REQUIRED_SLACK_BOT_SCOPES,
    });
    configureSlackConversations([STORED_CHANNEL]);
    const restored = await readSlackReadiness(fixture, fixture.actor);
    expect(restored.body).toMatchObject({ status: "ready", reason: null });
    await expectAutomationUnchanged(fixture);
  });

  it("offers personal connection only to the automation owner", async () => {
    const fixture = await setupSlackAutomation();
    await integrations.requestSlackDisconnect(fixture.actor, undefined, [200]);
    const visibleAdmin = caller(fixture, "org:admin");

    const ownerReadiness = await readSlackReadiness(fixture, fixture.actor);
    expect(ownerReadiness.body).toMatchObject({
      status: "setup-required",
      reason: "owner-not-connected",
      action: { kind: "connect", label: "Connect Slack" },
    });
    if (ownerReadiness.body.action?.kind !== "connect") {
      throw new Error("Expected the owner connection action");
    }
    expect(
      new URL(ownerReadiness.body.action.url).searchParams.get("vm0UserId"),
    ).toBe(fixture.actor.userId);

    const viewerReadiness = await readSlackReadiness(fixture, visibleAdmin);
    expect(viewerReadiness.body).toStrictEqual({
      eventType: "slack-user-mentioned",
      status: "setup-required",
      reason: "owner-not-connected",
      message:
        "The automation owner must connect their Slack account before this automation can run.",
      action: null,
    });
    expect(ownerReadiness.body.message).toBe(viewerReadiness.body.message);
    await expectAutomationUnchanged(fixture);
  });

  it("offers permission updates only to admins", async () => {
    const fixture = await setupSlackAutomation();
    await integrations.requestSlackDisconnect(
      fixture.actor,
      "uninstall",
      [200],
    );
    await integrations.installSlackWorkspace(fixture.actor, {
      botScopes: ["chat:write"],
    });
    const member = caller(fixture, "org:member");
    const admin = caller(fixture, "org:admin");

    const memberReadiness = await readSlackReadiness(fixture, member);
    expect(memberReadiness.body).toStrictEqual({
      eventType: "slack-user-mentioned",
      status: "setup-required",
      reason: "scope-mismatch",
      message: "Update Slack permissions before this automation can run.",
      action: null,
    });

    const adminReadiness = await readSlackReadiness(fixture, admin);
    expect(adminReadiness.body).toMatchObject({
      status: "setup-required",
      reason: "scope-mismatch",
      action: { kind: "reinstall", label: "Update permissions" },
    });
    expect(adminReadiness.body.message).toBe(memberReadiness.body.message);
    if (adminReadiness.body.action?.kind !== "reinstall") {
      throw new Error("Expected an admin-only reinstall action");
    }
    const actionUrl = new URL(adminReadiness.body.action.url);
    expect(actionUrl.searchParams.get("vm0UserId")).toBe(admin.userId);
    expect(actionUrl.searchParams.get("reinstall")).toBe("1");
    await expectAutomationUnchanged(fixture);
  });

  it("reports missing, archived, non-member, and name-only channel matches as unavailable", async () => {
    const fixture = await setupSlackAutomation();
    const channelCases: readonly (readonly SlackConversationFixture[])[] = [
      [],
      [{ ...STORED_CHANNEL, isArchived: true }],
      [{ ...STORED_CHANNEL, isMember: false }],
      [{ id: "C_OTHER", name: STORED_CHANNEL.id }],
    ];

    for (const channels of channelCases) {
      configureSlackConversations(channels);
      const readiness = await readSlackReadiness(fixture, fixture.actor);
      expect(readiness.body).toStrictEqual({
        eventType: "slack-user-mentioned",
        status: "setup-required",
        reason: "channel-unavailable",
        message:
          "The configured Slack channel is unavailable. Invite @Zero to the channel or update the automation channel.",
        action: null,
      });
    }

    await expectAutomationUnchanged(fixture);
  });

  it("returns the same 404 boundary for missing, invisible, and non-Slack automations", async () => {
    const fixture = await setupSlackAutomation({ visibility: "private" });

    const missing = await accept(
      automationsClient().getSlackReadiness({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [404],
    );

    const schedule = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: fixture.workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * 1-5",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    const nonSlack = await accept(
      automationsClient().getSlackReadiness({
        headers: authHeaders(),
        params: { id: schedule.body.id },
      }),
      [404],
    );

    const otherMember = caller(fixture, "org:member");
    authenticate(otherMember, fixture.orgId);
    const invisible = await accept(
      automationsClient().getSlackReadiness({
        headers: authHeaders(),
        params: { id: fixture.automationId },
      }),
      [404],
    );
    const notFoundBody = {
      error: {
        code: "NOT_FOUND",
        message: "Workflow automation not found",
      },
    } as const;
    expect(missing.body).toStrictEqual(notFoundBody);
    expect(nonSlack.body).toStrictEqual(notFoundBody);
    expect(invisible.body).toStrictEqual(notFoundBody);
  });

  it("maps Slack API and decryption failures to retryable server responses", async () => {
    const fixture = await setupSlackAutomation();

    useSecretKmsProbe(undefined, () => {
      return Promise.reject(new Error("KMS temporarily unavailable"));
    });
    const decryptFailure = await accept(
      automationsClient().getSlackReadiness({
        headers: authHeaders(),
        params: { id: fixture.automationId },
      }),
      [503],
    );
    expect(decryptFailure.body).toStrictEqual({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message:
          "Slack readiness is temporarily unavailable. Try again shortly.",
      },
    });

    useSecretKmsProbe();
    server.use(
      http.get(SLACK_CONVERSATIONS_URL, () => {
        return HttpResponse.json({ ok: false, error: "ratelimited" });
      }),
    );
    const slackFailure = await accept(
      automationsClient().getSlackReadiness({
        headers: authHeaders(),
        params: { id: fixture.automationId },
      }),
      [503],
    );
    expect(slackFailure.body).toStrictEqual(decryptFailure.body);

    await expectAutomationUnchanged(fixture);
  });
});
