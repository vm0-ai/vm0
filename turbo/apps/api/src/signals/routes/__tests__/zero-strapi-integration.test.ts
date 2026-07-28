import { randomUUID } from "node:crypto";

import { zeroStrapiIntegrationsContract } from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const CRON_SECRET = "strapi-cron-secret";
const WORKFLOW_NAME = "publish-strapi-blog";

function authHeaders() {
  return { authorization: "Bearer clerk-session" } as const;
}

function integrationsClient() {
  return setupApp({ context })(zeroStrapiIntegrationsContract);
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

async function postStrapiEvent(args: {
  readonly webhookUrl: string;
  readonly authorizationHeader: string;
  readonly payload: unknown;
  readonly eventHeader?: string;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await createApp({ signal: context.signal }).request(
    args.webhookUrl,
    {
      method: "POST",
      headers: {
        authorization: args.authorizationHeader,
        "content-type": "application/json",
        ...(args.eventHeader ? { "x-strapi-event": args.eventHeader } : {}),
      },
      body: JSON.stringify(args.payload),
    },
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  clearMockNow();
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
  mockEnv("CRON_SECRET", CRON_SECRET);
  context.mocks.s3.send.mockResolvedValue({});
});

describe("Strapi integration", () => {
  it("keeps the complete feature off outside the rollout", async () => {
    const actor = workflows.user({
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const response = await accept(
      integrationsClient().list({ headers: authHeaders() }),
      [403],
    );
    expect(response.body.error.message).toBe(
      "Strapi integration is not enabled",
    );
  });

  it("tests the external webhook and coalesces localized publishes", async () => {
    const actor = workflows.user({
      orgId: STAFF_ORG_ID,
      orgRole: "org:admin",
    });
    await runs.grantProEntitlement(actor, { tier: "team" });
    await runs.ensureOrgModelProvider(actor);
    const runnerGroup = runs.configureRunnerGroup();
    const agent = await workflows.createAgent(actor, {
      displayName: "Strapi automation agent",
    });
    const workflowId = await workflows.createWorkflow(actor, {
      agentId: agent.agentId,
      name: WORKFLOW_NAME,
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const strapiBaseUrl = `https://cms-${randomUUID()}.example.com`;
    const createdIntegration = await accept(
      integrationsClient().create({
        headers: authHeaders(),
        body: {
          name: "Marketing CMS",
          baseUrl: `${strapiBaseUrl}/`,
        },
      }),
      [201],
    );
    expect(createdIntegration.body.baseUrl).toBe(strapiBaseUrl);
    expect(new URL(createdIntegration.body.webhookUrl).pathname).toBe(
      `/api/zero/strapi/events/${createdIntegration.body.id}`,
    );
    expect(createdIntegration.body.authorizationHeader).toMatch(
      /^Bearer strapi_/,
    );

    const beforeTest = await accept(
      integrationsClient().checkTest({
        headers: authHeaders(),
        params: { integrationId: createdIntegration.body.id },
      }),
      [200],
    );
    expect(beforeTest.body).toStrictEqual({
      received: false,
      lastTestedAt: null,
    });

    const unauthorized = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: "Bearer wrong",
      eventHeader: "trigger-test",
      payload: {
        event: "trigger-test",
        createdAt: new Date(now()).toISOString(),
      },
    });
    expect(unauthorized.status).toBe(401);

    const tested = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "trigger-test",
      payload: {
        event: "trigger-test",
        createdAt: new Date(now()).toISOString(),
      },
    });
    expect(tested).toStrictEqual({
      status: 200,
      body: { success: true, kind: "test", queued: 0 },
    });
    const afterTest = await accept(
      integrationsClient().checkTest({
        headers: authHeaders(),
        params: { integrationId: createdIntegration.body.id },
      }),
      [200],
    );
    expect(afterTest.body.received).toBeTruthy();
    expect(afterTest.body.lastTestedAt).toStrictEqual(expect.any(String));

    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "strapi-entry-published",
          eventConfig: {
            provider: "strapi",
            event: "entry_published",
            integrationId: createdIntegration.body.id,
            contentTypeUid: "api::article.article",
          },
        },
      }),
      [201],
    );
    if (!automation.body.chatThreadId) {
      throw new Error("Expected Strapi automation chat thread");
    }

    const publishStartedAt = now() - 60_000;
    mockNow(publishStartedAt);
    const publishPayload = (locale: string) => {
      return {
        event: "entry.publish",
        createdAt: new Date(now()).toISOString(),
        model: "article",
        uid: "api::article.article",
        entry: { documentId: "article-document-1", locale },
      };
    };
    const englishPayload = publishPayload("en");
    const english = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "entry.publish",
      payload: englishPayload,
    });
    const chinese = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "entry.publish",
      payload: publishPayload("zh-CN"),
    });
    const duplicate = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "entry.publish",
      payload: englishPayload,
    });
    expect(english.body).toStrictEqual({
      success: true,
      kind: "publish",
      queued: 1,
    });
    expect(chinese.body).toStrictEqual({
      success: true,
      kind: "publish",
      queued: 1,
    });
    expect(duplicate.body).toStrictEqual({
      success: true,
      kind: "duplicate",
      queued: 0,
    });

    mockNow(publishStartedAt + 46_000);
    const cronResponse = await createApp({ signal: context.signal }).request(
      "/api/cron/execute-workflow-automations",
      { headers: { authorization: `Bearer ${CRON_SECRET}` } },
    );
    expect(cronResponse.status).toBe(200);
    await expect(cronResponse.json()).resolves.toMatchObject({
      success: true,
      executed: 1,
    });

    const messages = await workflows.readThreadMessages(
      automation.body.chatThreadId,
    );
    const runsForAutomation = messages.filter((message) => {
      return (
        message.role === "user" &&
        message.content === `/${WORKFLOW_NAME}` &&
        message.workflowSnapshot?.automationId === automation.body.id
      );
    });
    expect(runsForAutomation).toHaveLength(1);
    expect(runsForAutomation[0]?.workflowSnapshot?.triggerBrief).toContain(
      "(2 locales)",
    );

    const runId = runsForAutomation[0]?.runId;
    if (!runId) {
      throw new Error("Expected Strapi automation run ID");
    }
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(runId);
    expect(claim.appendSystemPrompt).toContain('"locales": [');
    expect(claim.appendSystemPrompt).toContain('"en"');
    expect(claim.appendSystemPrompt).toContain('"zh-CN"');
    expect(claim.appendSystemPrompt).not.toContain(
      createdIntegration.body.authorizationHeader,
    );
  });
});
