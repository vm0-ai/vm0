import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import {
  integrationsTeamsMessageContract,
  integrationsTeamsUploadCompleteContract,
} from "@vm0/api-contracts/contracts/integrations";
import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/zero-teams-connect";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const BOT_FRAMEWORK_TOKEN_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

interface CapturedTeamsActivity {
  conversationBody?: Record<string, unknown>;
  conversationId?: string;
  body?: Record<string, unknown>;
  authorization?: string | null;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: (args.capabilities ?? ["teams:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
  });
}

function teamsFixture(): TeamsConnectFixture {
  return teamsConnectFixture({
    orgId: `org_teams_cli_${randomUUID().slice(0, 8)}`,
    userId: `user_teams_cli_${randomUUID().slice(0, 8)}`,
    serviceUrl: SERVICE_URL,
  });
}

function mockOutgoingTeams(captured: CapturedTeamsActivity): void {
  server.use(
    http.post(BOT_FRAMEWORK_TOKEN_URL, async ({ request }) => {
      const form = await request.formData();
      expect(form.get("scope")).toBe("https://api.botframework.com/.default");
      return HttpResponse.json({ access_token: "bot-framework-token" });
    }),
    http.post(
      "https://smba.trafficmanager.net/amer/v3/conversations",
      async ({ request }) => {
        captured.authorization = request.headers.get("authorization");
        captured.conversationBody = (await request.json()) as Record<
          string,
          unknown
        >;
        return HttpResponse.json({ id: "a:teams-dm-conversation" });
      },
    ),
    http.post(
      "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities/:activityId",
      async ({ params, request }) => {
        captured.authorization = request.headers.get("authorization");
        captured.conversationId =
          typeof params.conversationId === "string"
            ? params.conversationId
            : undefined;
        captured.body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "teams-activity-1" });
      },
    ),
    http.post(
      "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities",
      async ({ params, request }) => {
        captured.authorization = request.headers.get("authorization");
        captured.conversationId =
          typeof params.conversationId === "string"
            ? params.conversationId
            : undefined;
        captured.body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "teams-activity-1" });
      },
    ),
  );
}

async function seedConnectedTeams(fixture: TeamsConnectFixture): Promise<void> {
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );
  await installTeamsForTest(context.signal, fixture);
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

  const client = setupApp({ context })(zeroTeamsConnectContract);
  await accept(
    client.connect({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsUserDisplayName: "Ada Lovelace",
        teamsUserPrincipalName: "ada@example.com",
      },
    }),
    [200],
  );
}

describe("Microsoft Teams integration CLI routes", () => {
  const fixtures: TeamsConnectFixture[] = [];

  beforeEach(() => {
    setupTeamsConnectTestEnv("https://app.vm0.test");
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "bot-password");
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await removeTeamsForTest(context.signal, fixture);
      }
    }
  });

  it("sends a Teams message through the installed bot", async () => {
    const fixture = teamsFixture();
    fixtures.push(fixture);
    await seedConnectedTeams(fixture);
    const captured: CapturedTeamsActivity = {};
    mockOutgoingTeams(captured);

    const client = setupApp({ context })(integrationsTeamsMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          conversationId: "19:thread@thread.tacv2",
          activityId: "root-activity",
          text: "Hello from Teams CLI",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: `run_${randomUUID()}`,
          })}`,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      ok: true,
      activityId: "teams-activity-1",
      conversationId: "19:thread@thread.tacv2",
    });
    expect(captured.authorization).toBe("Bearer bot-framework-token");
    expect(captured.body).toMatchObject({
      type: "message",
      text: "Hello from Teams CLI",
      textFormat: "markdown",
      replyToId: "root-activity",
      channelData: { tenant: { id: fixture.teamsTenantId } },
    });
  });

  it("sends a Teams DM with an Adaptive Card through the installed bot", async () => {
    const fixture = teamsFixture();
    fixtures.push(fixture);
    await seedConnectedTeams(fixture);
    const captured: CapturedTeamsActivity = {};
    mockOutgoingTeams(captured);

    const client = setupApp({ context })(integrationsTeamsMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          user: "me",
          text: "Pick a workflow",
          card: {
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              {
                type: "TextBlock",
                text: "Pick a workflow",
                wrap: true,
              },
            ],
          },
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: `run_${randomUUID()}`,
          })}`,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      ok: true,
      activityId: "teams-activity-1",
      conversationId: "a:teams-dm-conversation",
    });
    expect(captured.conversationBody).toMatchObject({
      bot: { id: "28:bot-1", name: "Zero" },
      members: [{ id: fixture.teamsUserId, name: "Ada Lovelace" }],
      isGroup: false,
      channelData: { tenant: { id: fixture.teamsTenantId } },
    });
    expect(captured.conversationId).toBe("a:teams-dm-conversation");
    expect(captured.body).toMatchObject({
      type: "message",
      summary: "Pick a workflow",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
          },
        },
      ],
      channelData: { tenant: { id: fixture.teamsTenantId } },
    });
  });

  it("sends an uploaded file URL as a Teams attachment", async () => {
    const fixture = teamsFixture();
    fixtures.push(fixture);
    await seedConnectedTeams(fixture);
    const captured: CapturedTeamsActivity = {};
    mockOutgoingTeams(captured);

    const uploadId = randomUUID();
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${fixture.userId}/${uploadId}/report.pdf`,
        size: 1234,
      },
    ]);

    const client = setupApp({ context })(
      integrationsTeamsUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: {
          uploadId,
          conversationId: "19:thread@thread.tacv2",
          activityId: "root-activity",
          contentType: "application/pdf",
          text: "Daily report",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      activityId: "teams-activity-1",
      conversationId: "19:thread@thread.tacv2",
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
    });
    expect(response.body.url).toContain(uploadId);
    expect(captured.body?.text).toContain("Daily report");
    expect(captured.body?.text).toContain("[report.pdf]");
    expect(captured.body).toMatchObject({
      type: "message",
      replyToId: "root-activity",
      attachments: [
        {
          contentType: "application/pdf",
          contentUrl: response.body.url,
          name: "report.pdf",
        },
      ],
    });
  });
});
