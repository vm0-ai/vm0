import { randomUUID } from "node:crypto";

import { testWorkflowAutomationExecutionContract } from "@vm0/api-contracts/contracts/test-workflow-automation-execution";
import { zeroStrapiIntegrationsContract } from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { fnv1a } from "@vm0/core/identity-hash";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventAutomationPart } from "./helpers/chat-event";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const FNV_PRIME = 16_777_619;
// Multiplicative inverse of FNV_PRIME modulo 2^32.
const FNV_PRIME_INVERSE = 899_433_627;
const ROLLOUT_COLLISION_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const WORKFLOW_NAME = "publish-strapi-blog";

function advanceFnv1a(hash: number, character: string): number {
  return Math.imul(hash ^ character.charCodeAt(0), FNV_PRIME) >>> 0;
}

function reverseFnv1a(hash: number, character: string): number {
  return (Math.imul(hash, FNV_PRIME_INVERSE) ^ character.charCodeAt(0)) >>> 0;
}

function rolloutCollisionSuffix(
  prefix: string,
  targetHash: number,
): string | null {
  // Meet in the middle over two three-character halves instead of scanning
  // all 62^6 suffixes. FNV-1a is reversible one character at a time.
  const prefixHash = Number.parseInt(fnv1a(prefix), 16);
  const firstHalves = new Map<number, string>();
  for (const first of ROLLOUT_COLLISION_ALPHABET) {
    for (const second of ROLLOUT_COLLISION_ALPHABET) {
      for (const third of ROLLOUT_COLLISION_ALPHABET) {
        const hash = advanceFnv1a(
          advanceFnv1a(advanceFnv1a(prefixHash, first), second),
          third,
        );
        firstHalves.set(hash, `${first}${second}${third}`);
      }
    }
  }

  for (const fourth of ROLLOUT_COLLISION_ALPHABET) {
    for (const fifth of ROLLOUT_COLLISION_ALPHABET) {
      for (const sixth of ROLLOUT_COLLISION_ALPHABET) {
        const precedingHash = reverseFnv1a(
          reverseFnv1a(reverseFnv1a(targetHash, sixth), fifth),
          fourth,
        );
        const firstHalf = firstHalves.get(precedingHash);
        if (firstHalf) {
          return `${firstHalf}${fourth}${fifth}${sixth}`;
        }
      }
    }
  }
  return null;
}

function uniqueRolloutOrgId(): string {
  const targetHash = Number.parseInt(fnv1a(STAFF_ORG_ID), 16);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const prefix = `org_${randomUUID()}_`;
    const suffix = rolloutCollisionSuffix(prefix, targetHash);
    if (suffix) {
      return `${prefix}${suffix}`;
    }
  }
  throw new Error("Failed to generate a unique Strapi rollout organization");
}

// Each test process gets an unshared tenant that still exercises the real
// organization-hash rollout path.
const SECOND_ROLLOUT_ORG_ID = uniqueRolloutOrgId();

function authHeaders() {
  return { authorization: "Bearer clerk-session" } as const;
}

function integrationsClient() {
  return setupApp({ context })(zeroStrapiIntegrationsContract);
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function workflowAutomationExecutionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
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
      orgId: SECOND_ROLLOUT_ORG_ID,
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
        return accept(
          workflowAutomationExecutionClient().execute({
            body: { automation_id: automation.body.id },
          }),
          [200],
        );
      }),
    );
    expect(
      cronResponses.every((response) => {
        return response.body.success;
      }),
    ).toBeTruthy();
    expect(
      cronResponses.reduce((total, response) => {
        return total + response.body.executed;
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
    const successorCron = await accept(
      workflowAutomationExecutionClient().execute({
        body: { automation_id: automation.body.id },
      }),
      [200],
    );
    expect(successorCron.body).toMatchObject({
      success: true,
      executed: 1,
    });
    await expect(
      pendingWorkflowEvents(automation.body.chatThreadId),
    ).resolves.toHaveLength(1);
  });
});
