import { createStore } from "ccstate";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { now } from "../../external/time";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
import {
  countSlackOrgConnections$,
  deleteSlackConnectOrg$,
  findSlackOrgConnection$,
  findSlackOrgInstallation$,
  seedSlackConnectOrg$,
  type SlackConnectFixture,
} from "./helpers/zero-slack-connect";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { decryptPersistentSecretValue } from "../../services/crypto.utils";

const context = testContext();
const store = createStore();
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const APP_ORIGIN = "https://app.vm0.ai";

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
  mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
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

function slackPostMessageContaining(text: string): boolean {
  return context.mocks.slack.chat.postMessage.mock.calls.some((call) => {
    const [message] = call;
    return hasTextField(message) && message.text.includes(text);
  });
}

function hasTextField(value: unknown): value is { readonly text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
  );
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
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    mockEnv("APP_URL", APP_ORIGIN);
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
        `${WEB_ORIGIN}/api/zero/slack/oauth/callback`,
      );
      const scopes = redirectUrl.searchParams.get("scope")?.split(",") ?? [];
      expect(scopes).toContain("app_mentions:read");
      expect(scopes).toContain("chat:write");
      expect(scopes).not.toContain("assistant:write");
      expect(scopes).toContain("channels:history");
      expect(scopes).toContain("im:history");
      expect(scopes).toContain("commands");
      expect(scopes).toContain("users:read");
      expect(scopes).toContain("files:read");
      expect(scopes).toContain("files:write");
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
      for (const char of state.prompt) {
        expect(char).toBe("\u{1F600}");
      }
    });

    it("includes the pending prompt in install state when provided", async () => {
      const response = await appRequest(
        `/api/zero/slack/oauth/install?orgId=org_1&vm0UserId=user_1&prompt=${encodeURIComponent("summarize my inbox")}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly orgId: string;
        readonly prompt: string;
        readonly vm0UserId: string;
      };
      expect(state).toStrictEqual({
        orgId: "org_1",
        prompt: "summarize my inbox",
        vm0UserId: "user_1",
      });
    });

    it("truncates long install prompts to protect OAuth state length", async () => {
      const prompt = "x".repeat(1200);

      const response = await appRequest(
        `/api/zero/slack/oauth/install?prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly prompt: string;
      };
      expect(state.prompt).toBe("x".repeat(500));
    });

    it("omits prompt from install state when absent", async () => {
      const response = await appRequest(
        "/api/zero/slack/oauth/install?orgId=org_1&vm0UserId=user_1",
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly prompt?: string;
      };
      expect(state.prompt).toBeUndefined();
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
      mockEnv("SLACK_OAUTH_CLIENT_ID", "");

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
        `${WEB_ORIGIN}/api/zero/slack/oauth/callback`,
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

    it("includes the pending prompt in connect state when provided", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/zero/slack/oauth/connect?orgId=${fixture.orgId}&vm0UserId=${fixture.userId}&prompt=${encodeURIComponent("summarize my inbox")}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly flow: string;
        readonly orgId: string;
        readonly prompt: string;
        readonly vm0UserId: string;
      };
      expect(state).toStrictEqual({
        flow: "connect",
        orgId: fixture.orgId,
        prompt: "summarize my inbox",
        vm0UserId: fixture.userId,
      });
    });

    it("truncates long connect prompts to protect OAuth state length", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      const prompt = "x".repeat(1200);

      const response = await appRequest(
        `/api/zero/slack/oauth/connect?orgId=${fixture.orgId}&vm0UserId=${fixture.userId}&prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly prompt: string;
      };
      expect(state.prompt).toBe("x".repeat(500));
    });

    it("truncates connect prompts without splitting Unicode codepoints", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      const prompt = "\u{1F600}".repeat(600);

      const response = await appRequest(
        `/api/zero/slack/oauth/connect?orgId=${fixture.orgId}&vm0UserId=${fixture.userId}&prompt=${encodeURIComponent(prompt)}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly prompt: string;
      };
      expect([...state.prompt]).toHaveLength(500);
      for (const char of state.prompt) {
        expect(char).toBe("\u{1F600}");
      }
    });

    it("omits prompt from connect state when absent", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );

      const response = await appRequest(
        `/api/zero/slack/oauth/connect?orgId=${fixture.orgId}&vm0UserId=${fixture.userId}`,
      );

      expect(response.status).toBe(307);
      const redirectUrl = new URL(response.headers.get("location")!);
      const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
        readonly prompt?: string;
      };
      expect(state.prompt).toBeUndefined();
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

    it("returns 503 when Slack client ID is not configured", async () => {
      mockEnv("SLACK_OAUTH_CLIENT_ID", "");

      const response = await appRequest(
        "/api/zero/slack/oauth/connect?orgId=org_1&vm0UserId=user_1",
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Slack integration is not configured",
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
        `${APP_ORIGIN}/settings/slack?status=connected`,
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
      await expect(
        decryptPersistentSecretValue(installation!.encryptedBotToken, {}),
      ).resolves.toBe("xoxb-test-token");
      expect(context.mocks.slack.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_uri: `${WEB_ORIGIN}/api/zero/slack/oauth/callback`,
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

    it("returns a framework error when the platform installer is not an org member", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      mockOAuthSuccess({ teamId: fixture.slackWorkspaceId });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Internal server error",
      });
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
      expect(location).toContain(`${APP_ORIGIN}/settings/slack`);
      expect(location).toContain(`w=${fixture.slackWorkspaceId}`);
      expect(location).toContain(`u=${fixture.slackUserId}`);

      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation?.orgId).toBeNull();
    });

    it("redirects to the failed page when the install OAuth exchange fails", async () => {
      context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
        ok: false,
        error: "invalid_code",
      });

      const response = await appRequest(
        "/api/zero/slack/oauth/callback?code=expired-code",
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain(`${APP_ORIGIN}/slack/failed`);
      expect(decodeURIComponent(location ?? "")).toContain(
        "Failed to complete Slack installation",
      );
    });

    it("rejects a platform install when the workspace belongs to another org", async () => {
      const originalOrgId = `org_original_${now()}`;
      const requestingOrgId = `org_requesting_${now()}`;
      const requestingUserId = `user_requesting_${now()}`;
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          {
            orgId: originalOrgId,
            slackWorkspaceId: "T_REJECTED",
          },
          context.signal,
        ),
      );
      await seedMembership(requestingOrgId, requestingUserId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        accessToken: "xoxb-requesting-token",
        authedUserId: "U_REQUESTING",
      });
      const state = JSON.stringify({
        orgId: requestingOrgId,
        vm0UserId: requestingUserId,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "already installed by another organization",
      );

      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation).toMatchObject({ orgId: originalOrgId });
      await expect(
        decryptPersistentSecretValue(installation!.encryptedBotToken, {}),
      ).resolves.toBe("xoxb-test-bot-token");
      const connection = await store.set(
        findSlackOrgConnection$,
        {
          slackWorkspaceId: fixture.slackWorkspaceId,
          slackUserId: "U_REQUESTING",
        },
        context.signal,
      );
      expect(connection).toBeUndefined();
    });

    it("updates token and scopes for a same-org platform reinstall", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        teamName: "Renamed Workspace",
        accessToken: "xoxb-refreshed-token",
        botUserId: "B_REFRESHED",
        authedUserId: fixture.slackUserId,
        scope: "chat:write,channels:read,users:read",
      });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=reinstall-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${APP_ORIGIN}/settings/slack?status=connected`,
      );
      const installation = await store.set(
        findSlackOrgInstallation$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(installation).toMatchObject({
        orgId: fixture.orgId,
        slackWorkspaceName: "Renamed Workspace",
        botUserId: "B_REFRESHED",
        botScopes: JSON.stringify([
          "chat:write",
          "channels:read",
          "users:read",
        ]),
      });
      await expect(
        decryptPersistentSecretValue(installation!.encryptedBotToken, {}),
      ).resolves.toBe("xoxb-refreshed-token");
    });

    it("creates a single connection across duplicate platform installs", async () => {
      const fixture = await track(
        store.set(
          seedSlackConnectOrg$,
          { installationOrgId: null },
          context.signal,
        ),
      );
      await store.set(deleteSlackConnectOrg$, fixture, context.signal);
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      await appRequest(
        `/api/zero/slack/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
      );
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=second-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const count = await store.set(
        countSlackOrgConnections$,
        fixture.slackWorkspaceId,
        context.signal,
      );
      expect(count).toBe(1);
    });

    it("sends the pending prompt DM for platform installs when state includes a prompt", async () => {
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
        authedUserId: fixture.slackUserId,
      });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
        prompt: "summarize my inbox",
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      await clearAllDetached();
      expect(slackPostMessageContaining("summarize my inbox")).toBeTruthy();
    });

    it("does not send a pending prompt DM for platform installs without a prompt", async () => {
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
        authedUserId: fixture.slackUserId,
      });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      await clearAllDetached();
      expect(
        slackPostMessageContaining("would you like me to run"),
      ).toBeFalsy();
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
      expect(connection).toMatchObject({ vm0UserId: fixture.userId });

      await clearAllDetached();
      expect(slackPostMessageContaining("summarize my inbox")).toBeTruthy();
    });

    it("does not send a pending prompt DM in the connect flow without a prompt", async () => {
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
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${APP_ORIGIN}/settings/slack?status=connected`,
      );
      await clearAllDetached();
      expect(
        slackPostMessageContaining("would you like me to run"),
      ).toBeFalsy();
    });

    it("redirects invalid connect state to the Slack settings error path", async () => {
      const state = JSON.stringify({ flow: "connect" });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        "/settings/slack?error=",
      );
      expect(context.mocks.slack.oauth.v2.access).not.toHaveBeenCalled();
    });

    it("redirects connect flow OAuth exchange failures to the Slack settings error path", async () => {
      const state = JSON.stringify({
        orgId: "org_exchange_failure",
        vm0UserId: "user_exchange_failure",
        flow: "connect",
      });
      context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
        ok: false,
        error: "invalid_code",
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=expired-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "Failed to connect Slack account",
      );
    });

    it("redirects connect flow when no installation exists for the org", async () => {
      const state = JSON.stringify({
        orgId: "org_missing_installation",
        vm0UserId: "user_missing_installation",
        flow: "connect",
      });
      mockOAuthSuccess({ teamId: "T_MISSING", authedUserId: "U_MISSING" });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "No Slack workspace installed for this organization",
      );
    });

    it("redirects connect flow when Slack returns a different workspace", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      mockOAuthSuccess({
        teamId: "T_DIFFERENT",
        authedUserId: fixture.slackUserId,
      });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
        flow: "connect",
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/settings/slack?error=");
      expect(decodeURIComponent(location ?? "")).toContain(
        "different Slack workspace",
      );
    });

    it("redirects explicit platform reinstalls back to the Works page", async () => {
      const fixture = await track(
        store.set(seedSlackConnectOrg$, {}, context.signal),
      );
      await seedMembership(fixture.orgId, fixture.userId, "admin");
      mockOAuthSuccess({
        teamId: fixture.slackWorkspaceId,
        authedUserId: fixture.slackUserId,
      });
      const state = JSON.stringify({
        orgId: fixture.orgId,
        vm0UserId: fixture.userId,
        reinstall: true,
      });

      const response = await appRequest(
        `/api/zero/slack/oauth/callback?code=reinstall-code&state=${encodeURIComponent(state)}`,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain(
        `${APP_ORIGIN}/?tab=works&updated=1`,
      );
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
        `${APP_ORIGIN}/slack/failed?error=access_denied`,
      );
    });
  });
});
