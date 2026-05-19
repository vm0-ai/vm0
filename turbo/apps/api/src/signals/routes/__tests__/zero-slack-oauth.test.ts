import { createStore } from "ccstate";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { now } from "../../external/time";
import { writeDb$ } from "../../external/db";
import {
  deleteSlackConnectOrg$,
  findSlackOrgConnection$,
  findSlackOrgInstallation$,
  seedSlackConnectOrg$,
  type SlackConnectFixture,
} from "./helpers/zero-slack-connect";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { decryptSecretValue } from "../../services/crypto.utils";

const context = testContext();
const store = createStore();
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";

async function appRequest(
  path: string,
  options: {
    readonly origin?: string;
    readonly headers?: HeadersInit;
  } = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(`${options.origin ?? "http://api.test"}${path}`, {
    method: "GET",
    headers: options.headers,
  });
}

function mockSlackEnv(): void {
  mockEnv("SLACK_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_CLIENT_SECRET", "test-slack-client-secret");
}

function mockOAuthSuccess(
  overrides: {
    readonly accessToken?: string;
    readonly botUserId?: string;
    readonly teamId?: string;
    readonly teamName?: string;
    readonly authedUserId?: string;
    readonly scope?: string;
  } = {},
): void {
  context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    access_token: overrides.accessToken ?? "xoxb-test-token",
    bot_user_id: overrides.botUserId ?? "B_TEST",
    team: {
      id: overrides.teamId ?? "T_TEST",
      name: overrides.teamName ?? "Test Workspace",
    },
    authed_user: { id: overrides.authedUserId ?? "U_TEST" },
    scope: overrides.scope,
  });
}

async function seedMembership(
  orgId: string,
  userId: string,
  role: "admin" | "member" = "admin",
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgMembersCache).values({
    orgId,
    userId,
    role,
    cachedAt: new Date(now()),
  });
}

async function deleteMembership(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
}

describe("Slack OAuth API routes", () => {
  const track = createFixtureTracker<SlackConnectFixture>(async (fixture) => {
    await store.set(deleteSlackConnectOrg$, fixture, context.signal);
    await deleteMembership(fixture.orgId);
  });

  beforeEach(() => {
    mockSlackEnv();
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

  describe("GET /api/zero/slack/oauth/install", () => {
    it("redirects to Slack OAuth with bot scopes and callback URI", async () => {
      const response = await appRequest("/api/zero/slack/oauth/install");

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      const redirectUrl = new URL(location!);
      expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(
        "https://slack.com/oauth/v2/authorize",
      );
      expect(redirectUrl.searchParams.get("client_id")).toBe(
        "test-slack-client-id",
      );
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        "http://api.test/api/zero/slack/oauth/callback",
      );
      expect(redirectUrl.searchParams.get("scope")).toContain("chat:write");
      expect(redirectUrl.searchParams.get("state")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("includes platform state and truncates prompt by codepoint", async () => {
      const prompt = "\u{1F600}".repeat(600);
      const response = await appRequest(
        `/api/zero/slack/oauth/install?orgId=org_1&vm0UserId=user_1&reinstall=1&prompt=${encodeURIComponent(prompt)}`,
      );

      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly orgId: string;
        readonly vm0UserId: string;
        readonly reinstall: boolean;
        readonly prompt: string;
      };
      expect(state.orgId).toBe("org_1");
      expect(state.vm0UserId).toBe("user_1");
      expect(state.reinstall).toBeTruthy();
      expect([...state.prompt]).toHaveLength(500);
    });

    it("uses the web rewrite origin for Slack callback URLs", async () => {
      const response = await appRequest("/api/zero/slack/oauth/install", {
        origin: API_ORIGIN,
        headers: { "x-vm0-web-origin": WEB_ORIGIN },
      });

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        `${WEB_ORIGIN}/api/zero/slack/oauth/callback`,
      );
    });

    it("redirects direct API host install requests to the canonical web route", async () => {
      const response = await appRequest(
        "/api/zero/slack/oauth/install?orgId=org_1&vm0UserId=user_1",
        { origin: API_ORIGIN },
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${WEB_ORIGIN}/api/zero/slack/oauth/install?orgId=org_1&vm0UserId=user_1`,
      );
    });

    it("ignores untrusted web origin headers on direct API host install requests", async () => {
      const response = await appRequest("/api/zero/slack/oauth/install", {
        origin: API_ORIGIN,
        headers: { "x-vm0-web-origin": "https://evil.example" },
      });

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${WEB_ORIGIN}/api/zero/slack/oauth/install`,
      );
    });

    it("returns 503 when Slack client ID is not configured", async () => {
      mockEnv("SLACK_CLIENT_ID", "");

      const response = await appRequest("/api/zero/slack/oauth/install");

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Slack integration is not configured",
      });
    });
  });

  describe("GET /api/zero/slack/oauth/connect", () => {
    it("redirects to Slack OAuth with team and connect state", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/zero/slack/oauth/connect?orgId=${fixture.orgId}&vm0UserId=${fixture.userId}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        "http://api.test/api/zero/slack/oauth/callback",
      );
      expect(redirectUrl.searchParams.get("user_scope")).toBe("identity.basic");
      expect(redirectUrl.searchParams.get("team")).toBe(
        fixture.slackWorkspaceId,
      );
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly flow: string;
        readonly orgId: string;
        readonly vm0UserId: string;
      };
      expect(state).toMatchObject({
        flow: "connect",
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });
    });

    it("uses the web rewrite origin for connect callback URLs", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/zero/slack/oauth/connect?orgId=${fixture.orgId}&vm0UserId=${fixture.userId}`,
        {
          origin: API_ORIGIN,
          headers: { "x-vm0-web-origin": WEB_ORIGIN },
        },
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        `${WEB_ORIGIN}/api/zero/slack/oauth/callback`,
      );
    });

    it("redirects direct API host connect requests to the canonical web route", async () => {
      const response = await appRequest(
        "/api/zero/slack/oauth/connect?orgId=org_1&vm0UserId=user_1",
        { origin: API_ORIGIN },
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${WEB_ORIGIN}/api/zero/slack/oauth/connect?orgId=org_1&vm0UserId=user_1`,
      );
    });

    it("returns 400 when orgId or vm0UserId is missing", async () => {
      const response = await appRequest(
        "/api/zero/slack/oauth/connect?orgId=org_1",
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Missing orgId or vm0UserId",
      });
    });

    it("returns 404 when no Slack installation exists for the org", async () => {
      const response = await appRequest(
        "/api/zero/slack/oauth/connect?orgId=org_missing&vm0UserId=user_1",
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: "No Slack workspace installed for this organization",
      });
    });
  });

  describe("GET /api/zero/slack/oauth/callback", () => {
    it("creates a platform installation and connection for an admin install", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        teamName: fixture.slackWorkspaceName,
        authedUserId: fixture.slackUserId,
        scope: "chat:write,channels:read",
      });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        "/settings/slack?status=connected",
      );

      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation).toMatchObject({
        orgId: fixture.orgId,
        installedByUserId: fixture.userId,
        botUserId: "B_TEST",
        botScopes: JSON.stringify(["chat:write", "channels:read"]),
      });
      expect(decryptSecretValue(installation!.encryptedBotToken)).toBe(
        "xoxb-test-token",
      );
      expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_uri: "http://api.test/api/zero/slack/oauth/callback",
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
      expect(connection).toMatchObject({ vm0UserId: fixture.userId });
    });

    it("uses the web rewrite origin for callback token exchange", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({ teamId: fixture.slackWorkspaceId });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          origin: API_ORIGIN,
          headers: { "x-vm0-web-origin": WEB_ORIGIN },
        },
      );

      expect(response.status).toBe(307);
      expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_uri: `${WEB_ORIGIN}/api/zero/slack/oauth/callback`,
        }),
      );
    });

    it("redirects direct API host callback requests to the canonical web route", async () => {
      const response = await appRequest(
        "/api/zero/slack/oauth/callback?code=valid-code&state=state-123",
        { origin: API_ORIGIN },
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${WEB_ORIGIN}/api/zero/slack/oauth/callback?code=valid-code&state=state-123`,
      );
      expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
    });

    it("rejects platform install for a non-admin member", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "member");
      mockOAuthSuccess({ teamId: fixture.slackWorkspaceId });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/slack/failed");
      expect(decodeURIComponent(location ?? "")).toContain("Only org admins");
    });

    it("creates an unbound installation for Slack-initiated installs", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        teamName: fixture.slackWorkspaceName,
        authedUserId: fixture.slackUserId,
      });

      const response = await appRequest(
        "/api/zero/slack/oauth/callback?code=valid-code",
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack");
      expect(location).toContain(`w=${fixture.slackWorkspaceId}`);
      expect(location).toContain(`u=${fixture.slackUserId}`);

      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation?.orgId).toBeNull();
    });

    it("connects an existing installed workspace through the connect flow", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      await seedMembership(fixture.orgId, fixture.userId, "member");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
        flow: "connect",
        prompt: "summarize my inbox",
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        "/settings/slack?status=connected",
      );

      const connection = await store.set(
        findSlackOrgConnection$,
        {
          slackWorkspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
        context.signal,
      );
      expect(connection).toMatchObject({ vm0UserId: fixture.userId });
    });

    it("returns 400 for missing callback code and redirects Slack errors", async () => {
      const missingCode = await appRequest("/api/zero/slack/oauth/callback");
      expect(missingCode.status).toBe(400);
      await expect(missingCode.json()).resolves.toStrictEqual({
        error: "Missing authorization code",
      });

      const slackError = await appRequest(
        "/api/zero/slack/oauth/callback?error=access_denied",
      );
      expect(slackError.status).toBe(307);
      expect(slackError.headers.get("location")).toBe(
        "http://localhost:3001/slack/failed?error=access_denied",
      );
    });
  });
});
