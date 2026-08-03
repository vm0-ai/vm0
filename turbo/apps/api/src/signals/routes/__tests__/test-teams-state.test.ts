import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import type {
  TestTeamsStatePostResponse,
  TestTeamsStateResponse,
} from "@vm0/api-contracts/contracts/test-teams-state";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { sendTeamsMessageReply } from "../../external/teams-bot-client";
import { testTeamsDispatchProbeRoutes } from "../test-teams-dispatch-probe";
import { testTeamsMockRoutes } from "../test-teams-mock";
import { testTeamsStateRoutes } from "../test-teams-state";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const TEAMS_STATE_ROUTE = "/api/test/teams-state";
const TEAMS_DISPATCH_PROBE_ROUTE = "/api/test/teams-dispatch-probe";
const TEAMS_SERVICE_URL = "https://teams.service.test/";
const TEAMS_TOKEN_URL = "https://teams-auth.test/token";

interface TeamsFixture {
  readonly tenantId: string;
  readonly teamsUserId: string;
  readonly teamsAadObjectId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string | null;
  readonly defaultAgentId: string | null;
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function uniqueId(prefix: string): string {
  return `${prefix}_${suffix()}`;
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...testTeamsStateRoutes,
      ...testTeamsDispatchProbeRoutes,
      ...testTeamsMockRoutes,
    ],
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function mockTestUserMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { createdAt: 20, organization: { id: uniqueId("org_later") } },
      { createdAt: 10, organization: { id: orgId } },
    ],
  });
}

async function deleteTeamsFixture(fixture: TeamsFixture): Promise<void> {
  mockEnv("ENV", "development");
  await requestApp(
    `${TEAMS_STATE_ROUTE}?tenant_id=${encodeURIComponent(
      fixture.tenantId,
    )}&org_id=${encodeURIComponent(fixture.orgId)}`,
    { method: "DELETE" },
  );
}

const trackTeamsFixture = createFixtureTracker(deleteTeamsFixture);

async function seedTeamsFixture(
  options: {
    readonly seedConnection?: boolean;
    readonly seedDefaultAgent?: boolean;
  } = {},
): Promise<TeamsFixture> {
  const userId = uniqueId("user");
  const orgId = uniqueId("org");
  const tenantId = uniqueId("tenant");
  const teamsUserId = `29:${uniqueId("teams_user")}`;
  const teamsAadObjectId = uniqueId("aad");
  mockTestUserMembership(userId, orgId);

  const response = await requestApp(TEAMS_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenant_id: tenantId,
      tenant_name: "Teams Test Tenant",
      team_id: "team-test",
      team_name: "Teams Test Team",
      service_url: TEAMS_SERVICE_URL,
      teams_user_id: teamsUserId,
      teams_aad_object_id: teamsAadObjectId,
      teams_user_display_name: "Teams User",
      teams_user_principal_name: "teams@example.test",
      email: `${userId}@example.test`,
      seed_connection: options.seedConnection ?? false,
      seed_default_agent: options.seedDefaultAgent ?? false,
    }),
  });
  const body = await readJson<TestTeamsStatePostResponse>(response);
  if (response.status !== 200) {
    throw new Error(
      `Expected Teams state seed to succeed, received ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }

  const fixture = {
    tenantId: body.tenant_id,
    teamsUserId,
    teamsAadObjectId,
    orgId: body.org_id,
    userId: body.vm0_user_id,
    connectionId: body.connection_id,
    defaultAgentId: body.default_agent_id,
  };
  await trackTeamsFixture(Promise.resolve(fixture));
  return fixture;
}

async function readTeamsState(
  tenantId: string,
): Promise<TestTeamsStateResponse> {
  const response = await requestApp(
    `${TEAMS_STATE_ROUTE}?tenant_id=${encodeURIComponent(tenantId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestTeamsStateResponse>(response);
}

function configureTeamsDispatchMocks(): void {
  mockEnv("ENV", "development");
  mockEnv("MICROSOFT_TEAMS_BOT_APP_ID", "teams-app-id");
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-app-password");
  mockEnv("APP_URL", "http://localhost:3002");
  mockEnv("VM0_WEB_URL", "http://localhost:3000");
  mockEnv("VM0_API_BACKEND_URL", "http://localhost:3001");
  mockOptionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL", TEAMS_TOKEN_URL);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.s3.send.mockResolvedValue({});
  server.use(
    http.post(TEAMS_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: "teams-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(
      `${TEAMS_SERVICE_URL}v3/conversations/:conversationId/activities`,
      () => {
        return HttpResponse.json({ id: "typing-activity" });
      },
    ),
    http.post(
      `${TEAMS_SERVICE_URL}v3/conversations/:conversationId/activities/:activityId`,
      () => {
        return HttpResponse.json({ id: "reply-activity" });
      },
    ),
  );
}

async function dispatchTeamsMessage(args: {
  readonly fixture: TeamsFixture;
  readonly text: string;
}): Promise<void> {
  configureTeamsDispatchMocks();
  const response = await requestApp(TEAMS_DISPATCH_PROBE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenant_id: args.fixture.tenantId,
      conversation_id: "19:e2e-dm@thread.v2",
      conversation_type: "personal",
      activity_id: "activity-e2e",
      teams_user_id: args.fixture.teamsUserId,
      teams_aad_object_id: args.fixture.teamsAadObjectId,
      teams_user_display_name: "Teams User",
      teams_user_principal_name: "teams@example.test",
      message_text: args.text,
      service_url: TEAMS_SERVICE_URL,
    }),
  });
  expect(response.status).toBe(200);
  await expect(
    readJson<{ readonly ok: boolean }>(response),
  ).resolves.toStrictEqual({ ok: true });
}

describe("GET /api/test/teams-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${TEAMS_STATE_ROUTE}?tenant_id=tenant`);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires tenant_id or org_id", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(TEAMS_STATE_ROUTE);

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "tenant_id or org_id query param is required",
    });
  });

  it("returns seeded Teams diagnostics and dispatch state", async () => {
    const fixture = await seedTeamsFixture({
      seedConnection: true,
      seedDefaultAgent: true,
    });
    await dispatchTeamsMessage({
      fixture,
      text: "hello from teams diagnostics",
    });

    const body = await readTeamsState(fixture.tenantId);

    expect(body.installation).toMatchObject({
      teamsTenantId: fixture.tenantId,
      teamsTenantName: "Teams Test Tenant",
      orgId: fixture.orgId,
      installedByUserId: fixture.userId,
      serviceUrl: TEAMS_SERVICE_URL,
    });
    expect(body.connections).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.connectionId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          vm0UserId: fixture.userId,
          dmWelcomeSent: false,
        }),
      ]),
    );
    expect(body.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          triggerSource: "teams",
          userId: fixture.userId,
          error: null,
          promptPreview: "hello from teams diagnostics",
        }),
      ]),
    );
    const teamsRun = body.recent_runs.find((run) => {
      return run.promptPreview === "hello from teams diagnostics";
    });
    if (!teamsRun?.chatThreadId) {
      throw new Error("Expected the Teams run to use a canonical chat thread");
    }
    expect(body.routes).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: fixture.connectionId,
          conversationId: "19:e2e-dm@thread.v2",
          userId: fixture.userId,
          chatThreadId: teamsRun.chatThreadId,
        }),
      ]),
    );
    expect(body.recent_callbacks).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          internalKind: "chat",
          attempts: 0,
          lastError: null,
          payload: expect.objectContaining({
            threadId: teamsRun.chatThreadId,
            teamsDelivery: expect.objectContaining({
              tenantId: fixture.tenantId,
              conversationId: "19:e2e-dm@thread.v2",
              activityId: "activity-e2e",
              connectionId: fixture.connectionId,
            }),
          }),
        }),
      ]),
    );
    expect(body.org_metadata).toMatchObject({
      orgId: fixture.orgId,
      defaultAgentId: fixture.defaultAgentId,
      credits: 10_000,
      tier: "free",
    });
    expect(body.default_agent).toStrictEqual({
      id: fixture.defaultAgentId,
      name: "e2e-teams-agent",
      orgId: fixture.orgId,
    });
    expect(body.default_compose).toMatchObject({
      id: fixture.defaultAgentId,
      name: "e2e-teams-agent",
    });
    expect(body.default_compose_version).toMatchObject({
      content_keys: expect.arrayContaining(["version", "agents"]),
    });
  });

  it("returns persisted Teams mock calls for e2e assertions", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedTeamsFixture();

    const response = await requestApp(
      "/api/test/teams-mock/service/v3/conversations/19%3Ae2e-dm%40thread.v2/activities/activity-e2e",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "message",
          text: "HELLO_FROM_TEAMS_E2E",
          channelData: { tenant: { id: fixture.tenantId } },
        }),
      },
    );
    expect(response.status).toBe(200);

    const body = await readTeamsState(fixture.tenantId);
    expect(body.mock_calls).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "replyActivity",
          tenantId: fixture.tenantId,
          activityId: "activity-e2e",
          bodyJson: expect.objectContaining({
            text: "HELLO_FROM_TEAMS_E2E",
          }),
        }),
      ]),
    );
  });
});

describe("Teams e2e mock routing", () => {
  it("uses the preview API mock URL and bypass headers for Teams callbacks", async () => {
    mockEnv("MICROSOFT_TEAMS_BOT_APP_ID", undefined);
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", undefined);
    mockOptionalEnv("E2E_TEAMS_MOCK_ENABLED", "1");
    mockOptionalEnv("VERCEL_URL", undefined);
    mockOptionalEnv("VM0_API_BACKEND_URL", "https://api-preview.test");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const tokenRequests: URLSearchParams[] = [];
    const postedBodies: unknown[] = [];
    server.use(
      http.post(
        "https://api-preview.test/api/test/teams-mock/token",
        async ({ request }) => {
          expect(request.headers.get("x-vercel-protection-bypass")).toBe(
            "preview-secret",
          );
          expect(request.headers.get("x-vm0-test-endpoint-bypass")).toBe(
            "preview-secret",
          );
          tokenRequests.push(new URLSearchParams(await request.text()));
          return HttpResponse.json({
            access_token: "teams-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      ),
      http.post(
        "https://api-preview.test/api/test/teams-mock/service/v3/conversations/:conversationId/activities/:activityId",
        async ({ request }) => {
          expect(request.headers.get("x-vercel-protection-bypass")).toBe(
            "preview-secret",
          );
          expect(request.headers.get("x-vm0-test-endpoint-bypass")).toBe(
            "preview-secret",
          );
          postedBodies.push(await request.json());
          return HttpResponse.json({ id: "reply-activity" });
        },
      ),
    );

    const result = await sendTeamsMessageReply({
      serviceUrl: "https://api-preview.test/api/test/teams-mock/service/",
      conversationId: "19:e2e-dm@thread.v2",
      activityId: "activity-e2e",
      tenantId: "tenant-e2e",
      text: "HELLO_FROM_TEAMS_E2E",
      signal: context.signal,
    });

    expect(result).toStrictEqual({
      kind: "ok",
      activityId: "reply-activity",
    });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("client_id")).toBe("e2e-teams-bot-app-id");
    expect(tokenRequests[0]?.get("client_secret")).toBe(
      "e2e-teams-bot-app-password",
    );
    expect(tokenRequests[0]?.get("scope")).toBe(
      "https://api.botframework.com/.default",
    );
    expect(postedBodies).toStrictEqual([
      expect.objectContaining({
        type: "message",
        text: "HELLO_FROM_TEAMS_E2E",
        channelData: {
          tenant: { id: "tenant-e2e" },
        },
      }),
    ]);
  });
});

describe("POST /api/test/teams-dispatch-probe", () => {
  beforeEach(() => {
    context.mocks.clerk.users.getUserList.mockReset();
    context.mocks.clerk.users.getOrganizationMembershipList.mockReset();
  });

  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(TEAMS_DISPATCH_PROBE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns a validation error for bad bodies", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(TEAMS_DISPATCH_PROBE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant" }),
    });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error:
        "tenant_id, conversation_id, teams_user_id, and message_text are required",
    });
  });

  it("drains a persisted Teams message when realtime publishing fails", async () => {
    const fixture = await seedTeamsFixture({
      seedConnection: true,
      seedDefaultAgent: true,
    });
    const publishError = new Error("Ably channel rate limit exceeded");
    context.mocks.axiomLogging.warn.mockClear();
    context.mocks.ably.publish.mockRejectedValue(publishError);

    await dispatchTeamsMessage({
      fixture,
      text: "dispatch despite realtime failure",
    });

    expect((await readTeamsState(fixture.tenantId)).recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          triggerSource: "teams",
          promptPreview: "dispatch despite realtime failure",
        }),
      ]),
    );
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledWith(
      "Failed to publish thread list changed signal",
      expect.objectContaining({
        userId: fixture.userId,
        error: publishError,
      }),
    );
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledWith(
      "Failed to publish chat thread run created signal",
      expect.objectContaining({
        threadId: expect.any(String),
        error: publishError,
      }),
    );
  });

  it("does not enqueue runs for unlinked users or missing default agents", async () => {
    const unlinked = await seedTeamsFixture({
      seedConnection: false,
      seedDefaultAgent: true,
    });
    await dispatchTeamsMessage({ fixture: unlinked, text: "unlinked teams" });
    expect((await readTeamsState(unlinked.tenantId)).recent_runs).toStrictEqual(
      [],
    );

    const missingDefault = await seedTeamsFixture({
      seedConnection: true,
      seedDefaultAgent: false,
    });
    await dispatchTeamsMessage({
      fixture: missingDefault,
      text: "missing default teams",
    });
    expect(
      (await readTeamsState(missingDefault.tenantId)).recent_runs,
    ).toStrictEqual([]);
  });
});
