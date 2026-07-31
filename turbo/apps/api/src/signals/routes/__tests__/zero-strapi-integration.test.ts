import { randomUUID } from "node:crypto";

import { zeroStrapiIntegrationsContract } from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventAutomationPart } from "./helpers/chat-event";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
// Synthetic tenant whose FNV-1a value matches the staff rollout allowlist, so
// tenant isolation can be exercised entirely through external API behavior.
const SECOND_ROLLOUT_ORG_ID = "org_j3tn5H";
const CRON_SECRET = "strapi-cron-secret";
const WORKFLOW_NAME = "publish-strapi-blog";
const STRAPI_AUTOMATION_USER_ID = "user_strapi_automation_admin";

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

async function pendingWorkflowEvents(threadId: string) {
  const events = await workflows.readThreadEvents(threadId);
  const revokedIds = new Set(
    events.flatMap((event) => {
      return event.revokesEventId ? [event.revokesEventId] : [];
    }),
  );
  return events.filter(
    (
      event,
    ): event is Extract<
      (typeof events)[number],
      { readonly eventType: "input.automation" }
    > => {
      return (
        event.eventType === "input.automation" &&
        event.runId === undefined &&
        !revokedIds.has(event.id)
      );
    },
  );
}

async function workflowAutomationRuns(threadId: string, workflowId: string) {
  const events = await workflows.readThreadEvents(threadId);
  return events.filter((event) => {
    const automationPart = chatEventAutomationPart(event);
    return (
      event.eventType === "input.prompt" &&
      automationPart?.workflowName === WORKFLOW_NAME &&
      automationPart.workflowId === workflowId
    );
  });
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

  it("requires organization admins and keeps integrations tenant-scoped", async () => {
    const admin = workflows.user({
      orgId: STAFF_ORG_ID,
      orgRole: "org:admin",
    });
    mocks.clerk.session(admin.userId, admin.orgId, admin.orgRole);

    const ownIntegration = await accept(
      integrationsClient().create({
        headers: authHeaders(),
        body: {
          name: "Admin-owned CMS",
          baseUrl: `https://admin-${randomUUID()}.example.com`,
        },
      }),
      [201],
    );

    const member = workflows.user({
      orgId: STAFF_ORG_ID,
      orgRole: "org:member",
    });
    mocks.clerk.session(member.userId, member.orgId, member.orgRole);
    const memberList = await accept(
      integrationsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      memberList.body.map((integration) => {
        return integration.id;
      }),
    ).toContain(ownIntegration.body.id);
    await accept(
      integrationsClient().create({
        headers: authHeaders(),
        body: {
          name: "Member CMS",
          baseUrl: `https://member-${randomUUID()}.example.com`,
        },
      }),
      [403],
    );
    await accept(
      integrationsClient().revealSecret({
        headers: authHeaders(),
        params: { integrationId: ownIntegration.body.id },
      }),
      [403],
    );
    await accept(
      integrationsClient().checkTest({
        headers: authHeaders(),
        params: { integrationId: ownIntegration.body.id },
      }),
      [403],
    );
    await accept(
      integrationsClient().remove({
        headers: authHeaders(),
        params: { integrationId: ownIntegration.body.id },
      }),
      [403],
    );

    const foreignAdmin = workflows.user({
      orgId: SECOND_ROLLOUT_ORG_ID,
      orgRole: "org:admin",
    });
    mocks.clerk.session(
      foreignAdmin.userId,
      foreignAdmin.orgId,
      foreignAdmin.orgRole,
    );
    const foreignIntegration = await accept(
      integrationsClient().create({
        headers: authHeaders(),
        body: {
          name: "Foreign CMS",
          baseUrl: `https://foreign-${randomUUID()}.example.com`,
        },
      }),
      [201],
    );

    mocks.clerk.session(admin.userId, admin.orgId, admin.orgRole);
    const adminList = await accept(
      integrationsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      adminList.body.map((integration) => {
        return integration.id;
      }),
    ).toContain(ownIntegration.body.id);
    expect(
      adminList.body.map((integration) => {
        return integration.id;
      }),
    ).not.toContain(foreignIntegration.body.id);
    await accept(
      integrationsClient().revealSecret({
        headers: authHeaders(),
        params: { integrationId: foreignIntegration.body.id },
      }),
      [404],
    );
    await accept(
      integrationsClient().checkTest({
        headers: authHeaders(),
        params: { integrationId: foreignIntegration.body.id },
      }),
      [404],
    );
    await accept(
      integrationsClient().remove({
        headers: authHeaders(),
        params: { integrationId: foreignIntegration.body.id },
      }),
      [404],
    );

    await accept(
      integrationsClient().remove({
        headers: authHeaders(),
        params: { integrationId: ownIntegration.body.id },
      }),
      [204],
    );
    mocks.clerk.session(
      foreignAdmin.userId,
      foreignAdmin.orgId,
      foreignAdmin.orgRole,
    );
    await accept(
      integrationsClient().remove({
        headers: authHeaders(),
        params: { integrationId: foreignIntegration.body.id },
      }),
      [204],
    );
  });

  it("tests the external webhook and coalesces localized publishes", async () => {
    const actor = workflows.user({
      userId: STRAPI_AUTOMATION_USER_ID,
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
    const cronResponses = await Promise.all(
      [0, 1].map(() => {
        return createApp({ signal: context.signal }).request(
          "/api/cron/execute-workflow-automations",
          { headers: { authorization: `Bearer ${CRON_SECRET}` } },
        );
      }),
    );
    expect(
      cronResponses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    const cronBodies = (await Promise.all(
      cronResponses.map(async (response) => {
        return (await response.json()) as {
          readonly success: boolean;
          readonly executed: number;
        };
      }),
    )) satisfies readonly {
      readonly success: boolean;
      readonly executed: number;
    }[];
    expect(
      cronBodies.every((body) => {
        return body.success;
      }),
    ).toBeTruthy();
    expect(
      cronBodies.reduce((total, body) => {
        return total + body.executed;
      }, 0),
    ).toBe(1);

    const duplicateAfterAdmission = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "entry.publish",
      payload: englishPayload,
    });
    expect(duplicateAfterAdmission.body).toStrictEqual({
      success: true,
      kind: "duplicate",
      queued: 0,
    });

    const runsForAutomation = await workflowAutomationRuns(
      automation.body.chatThreadId,
      workflowId,
    );
    expect(runsForAutomation).toHaveLength(1);
    expect(
      chatEventAutomationPart(runsForAutomation[0]!)?.automationBrief,
    ).toContain("(2 locales)");

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

    const nextPublishStartedAt = publishStartedAt + 47_000;
    mockNow(nextPublishStartedAt);
    const publishDuringRun = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "entry.publish",
      payload: publishPayload("fr"),
    });
    expect(publishDuringRun.body).toStrictEqual({
      success: true,
      kind: "publish",
      queued: 1,
    });

    mockNow(nextPublishStartedAt + 46_000);
    const successorCron = await createApp({
      signal: context.signal,
    }).request("/api/cron/execute-workflow-automations", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(successorCron.status).toBe(200);
    await expect(successorCron.json()).resolves.toMatchObject({
      success: true,
      executed: 1,
    });
    await expect(
      pendingWorkflowEvents(automation.body.chatThreadId),
    ).resolves.toHaveLength(1);
  });

  it("retries durable admission after queue encryption fails", async () => {
    const actor = workflows.user({
      userId: STRAPI_AUTOMATION_USER_ID,
      orgId: STAFF_ORG_ID,
      orgRole: "org:admin",
    });
    await runs.grantProEntitlement(actor, { tier: "team" });
    await runs.ensureOrgModelProvider(actor);
    const agent = await workflows.createAgent(actor, {
      displayName: "Strapi retry agent",
    });
    const workflowId = await workflows.createWorkflow(actor, {
      agentId: agent.agentId,
      name: WORKFLOW_NAME,
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const createdIntegration = await accept(
      integrationsClient().create({
        headers: authHeaders(),
        body: {
          name: "Retry CMS",
          baseUrl: `https://retry-${randomUUID()}.example.com`,
        },
      }),
      [201],
    );
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

    const publishedAt = now();
    mockNow(publishedAt);
    const publishPayload = {
      event: "entry.publish",
      createdAt: new Date(now()).toISOString(),
      model: "article",
      uid: "api::article.article",
      entry: {
        documentId: "retry-article-document",
        locale: "en",
      },
    };
    const published = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "entry.publish",
      payload: publishPayload,
    });
    expect(published.body).toStrictEqual({
      success: true,
      kind: "publish",
      queued: 1,
    });

    const encryptionError = new Error("queue payload encryption failed");
    const kms = useSecretKmsProbe((_command, callNumber) => {
      return callNumber === 1 ? Promise.reject(encryptionError) : undefined;
    });
    const firstCronAt = publishedAt + 46_000;
    mockNow(firstCronAt);
    const failedCron = await createApp({
      signal: context.signal,
    }).request("/api/cron/execute-workflow-automations", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(failedCron.status).toBe(200);
    await expect(failedCron.json()).resolves.toMatchObject({
      success: true,
      executed: 0,
      skipped: 1,
    });
    expect(kms.generateDataKeyCalls).toBe(1);

    await expect(
      pendingWorkflowEvents(automation.body.chatThreadId),
    ).resolves.toHaveLength(0);
    const eventsAfterFailure = await workflows.readThreadEvents(
      automation.body.chatThreadId,
    );
    expect(
      eventsAfterFailure.filter((event) => {
        return (
          chatEventAutomationPart(event)?.workflowId === automation.body.id
        );
      }),
    ).toHaveLength(0);

    const duplicate = await postStrapiEvent({
      webhookUrl: createdIntegration.body.webhookUrl,
      authorizationHeader: createdIntegration.body.authorizationHeader,
      eventHeader: "entry.publish",
      payload: publishPayload,
    });
    expect(duplicate.body).toStrictEqual({
      success: true,
      kind: "duplicate",
      queued: 0,
    });

    mockNow(firstCronAt + 60_001);
    const retriedCron = await createApp({
      signal: context.signal,
    }).request("/api/cron/execute-workflow-automations", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(retriedCron.status).toBe(200);
    await expect(retriedCron.json()).resolves.toMatchObject({
      success: true,
      executed: 1,
      skipped: 0,
    });
    expect(kms.generateDataKeyCalls).toBe(2);

    const runsAfterRetry = await workflowAutomationRuns(
      automation.body.chatThreadId,
      workflowId,
    );
    expect(runsAfterRetry).toHaveLength(1);
    const runId = runsAfterRetry[0]?.runId;
    expect(runId).toStrictEqual(expect.any(String));

    const finalCron = await createApp({
      signal: context.signal,
    }).request("/api/cron/execute-workflow-automations", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(finalCron.status).toBe(200);
    await expect(finalCron.json()).resolves.toMatchObject({
      success: true,
      executed: 0,
      skipped: 0,
    });
    expect(
      (
        await workflowAutomationRuns(automation.body.chatThreadId, workflowId)
      )[0]?.runId,
    ).toBe(runId);
  });
});
