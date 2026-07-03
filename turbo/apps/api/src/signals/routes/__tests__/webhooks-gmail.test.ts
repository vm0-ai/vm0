import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID, sign as signData } from "node:crypto";

import {
  zeroWorkflowTriggersContract,
  type ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const chatApi = createChatFilesBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const miscApi = createMiscRoutesApi(context);
const webhooksApi = createWebhookCallbackApi(context);

const WORKFLOW_NAME = "gmail-webhook-workflow";
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const GMAIL_AUDIENCE = "https://api.vm0.ai/api/webhooks/gmail";
const GMAIL_PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";
const GMAIL_WORKSPACE_MODEL = "claude-sonnet-5";
const GOOGLE_OIDC_CERT_KID = "gmail-pubsub-test-key";
const googleOidcKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleOidcPublicKeyPem = googleOidcKeyPair.publicKey.export({
  type: "spki",
  format: "pem",
});

interface GmailTestFixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly workflowId: string;
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxOperationEvents(): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return isRecord(event);
    });
  });
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedGoogleIdToken(): string {
  const issuedAt = Math.floor(now() / 1000);
  const header = {
    alg: "RS256",
    kid: GOOGLE_OIDC_CERT_KID,
    typ: "JWT",
  };
  const payload = {
    aud: GMAIL_AUDIENCE,
    email: GMAIL_PUSH_SERVICE_ACCOUNT,
    email_verified: true,
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: "https://accounts.google.com",
    sub: "gmail-pubsub-test-subject",
  };
  const signedContent = `${encodeJwtPart(header)}.${encodeJwtPart(payload)}`;
  const signature = signData(
    "RSA-SHA256",
    Buffer.from(signedContent, "utf8"),
    googleOidcKeyPair.privateKey,
  );
  return `${signedContent}.${signature.toString("base64url")}`;
}

function configureGoogleOidcCertMock(): void {
  server.use(
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json(
        { [GOOGLE_OIDC_CERT_KID]: googleOidcPublicKeyPem },
        { headers: { "cache-control": "no-cache" } },
      );
    }),
  );
}

function configureGmailEnv(): void {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
  mockOptionalEnv("GMAIL_PUBSUB_PUSH_AUDIENCE", GMAIL_AUDIENCE);
  mockOptionalEnv(
    "GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    GMAIL_PUSH_SERVICE_ACCOUNT,
  );
  configureGoogleOidcCertMock();
}

function configureGmailWatchMock(historyId = "100"): void {
  server.use(
    http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
      return HttpResponse.json({
        historyId,
        expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
      });
    }),
  );
}

function uniqueGmailEmail(): string {
  return `webhook-user-${randomUUID()}@example.com`;
}

function gmailBodyData(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function configureGmailMessageMocks(gmailEmail: string): void {
  server.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer gmail-access-token",
        );
        expect(
          new URL(request.url).searchParams.get("startHistoryId"),
        ).toBeTruthy();
        return HttpResponse.json({
          history: [
            {
              id: "101",
              messagesAdded: [
                {
                  message: {
                    id: "msg-1",
                    threadId: "gmail-thread-1",
                    labelIds: ["INBOX"],
                  },
                },
              ],
            },
          ],
          historyId: "101",
        });
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId",
      () => {
        return HttpResponse.json({
          id: "msg-1",
          threadId: "gmail-thread-1",
          labelIds: ["INBOX", "IMPORTANT"],
          payload: {
            mimeType: "multipart/alternative",
            headers: [
              {
                name: "From",
                value: "Customer Example <customer@example.com>",
              },
              { name: "To", value: gmailEmail },
              { name: "Subject", value: "Invoice needs a reply" },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: {
                  data: gmailBodyData("Please draft a helpful reply."),
                },
              },
            ],
          },
        });
      },
    ),
  );
}

function configureGmailLabelsMockSequence(
  labelsByCall: readonly (readonly {
    readonly id: string;
    readonly name: string;
  }[])[],
): void {
  let callIndex = 0;
  server.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels", () => {
      const labels =
        labelsByCall[Math.min(callIndex, labelsByCall.length - 1)] ?? [];
      callIndex += 1;
      return HttpResponse.json({ labels });
    }),
  );
}

function configureGmailLabelAppliedMocks(
  labelId: string,
  gmailEmail: string,
): void {
  server.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () => {
      return HttpResponse.json({
        history: [
          {
            id: "102",
            labelsAdded: [
              {
                message: {
                  id: "msg-labeled",
                  threadId: "gmail-thread-labeled",
                },
                labelIds: [labelId],
              },
            ],
          },
        ],
        historyId: "102",
      });
    }),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId",
      () => {
        return HttpResponse.json({
          id: "msg-labeled",
          threadId: "gmail-thread-labeled",
          labelIds: ["INBOX", labelId],
          payload: {
            headers: [
              { name: "From", value: "Support Team <support@example.com>" },
              { name: "To", value: gmailEmail },
              { name: "Subject", value: "Support request" },
            ],
          },
        });
      },
    ),
  );
}

function gmailPushBody(args: {
  readonly emailAddress: string;
  readonly historyId: string | number;
  readonly messageId: string;
}): string {
  return JSON.stringify({
    message: {
      messageId: args.messageId,
      data: Buffer.from(
        JSON.stringify({
          emailAddress: args.emailAddress,
          historyId: args.historyId,
        }),
        "utf8",
      ).toString("base64"),
    },
  });
}

async function postGmailWebhook(
  rawBody: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await createApp({ signal: context.signal }).request(
    "/api/webhooks/gmail",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${signedGoogleIdToken()}`,
        "Content-Type": "application/json",
      },
      body: rawBody,
    },
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

function expectResponseStatus(
  response: { readonly status: number; readonly body: unknown },
  status: number,
): void {
  if (response.status !== status) {
    throw new Error(
      `Expected status ${status}, received ${response.status}: ${JSON.stringify(
        response.body,
      )}`,
    );
  }
}

async function enableGmailWorkflowTriggers(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.WorkflowAutomation]: true,
  });
}

async function configureWorkspaceModelProvider(
  actor: ApiTestUser,
): Promise<void> {
  const provider = await miscApi.upsertOrgModelProvider(
    actor,
    {
      type: "anthropic-api-key",
      secret: "sk-ant-gmail-webhook-bdd",
    },
    [200, 201],
  );
  if (provider.status !== 200 && provider.status !== 201) {
    throw new Error(
      `Expected model provider setup to succeed, got ${provider.status}`,
    );
  }
  const providerId = provider.body.provider.id;
  const policies = await miscApi.listModelPolicies(actor);
  const sonnetPolicy = policies.policies.find((policy) => {
    return policy.model === GMAIL_WORKSPACE_MODEL;
  });
  if (!sonnetPolicy) {
    throw new Error(
      `Expected ${GMAIL_WORKSPACE_MODEL} model policy to be available`,
    );
  }
  await miscApi.updateModelPolicies(
    actor,
    [
      {
        ...sonnetPolicy,
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ],
    [200],
  );
  const updated = await miscApi.listModelPolicies(actor);
  expect(
    updated.policies.find((policy) => {
      return policy.model === GMAIL_WORKSPACE_MODEL;
    }),
  ).toMatchObject({
    defaultProviderType: "anthropic-api-key",
    modelProviderId: providerId,
  });
}

async function grantVisibleCredits(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  webhooksApi.configureStripeBillingEnv();
  const response = await webhooksApi.postStripeEvent(
    {
      id: `evt_gmail_credit_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_gmail_credit_${randomUUID()}`,
          invoice: null,
          subscription: null,
          customer: null,
          metadata: {
            purpose: "credit_purchase",
            orgId: actor.orgId,
            creditsAmountMode: "amount_total",
          },
          amount_total: 1000,
          payment_status: "paid",
        },
      },
    },
    [200],
  );
  expect(response.body).toBe("OK");
}

async function connectGmail(
  actor: ApiTestUser,
  gmailEmail: string,
): Promise<void> {
  mockGmailConnectorOAuth({
    accessToken: "gmail-access-token",
    email: gmailEmail,
  });
  const start = await connectorsApi.startOauth(actor, "gmail", "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth start URL to include state");
  }

  await connectorsApi.completeOauthCallback("gmail", {
    code: "gmail-code",
    state,
  });
  const connector = await connectorsApi.readConnectorByType(actor, "gmail");
  expect(connector).toMatchObject({
    authMethod: "oauth",
    externalEmail: gmailEmail,
    type: "gmail",
  });
}

async function setupFixture(): Promise<GmailTestFixture> {
  const actor = bdd.user({
    email: "gmail-webhook-owner@example.test",
    orgRole: "org:admin",
  });
  if (!actor.orgId) {
    throw new Error("Expected Gmail webhook fixture actor to have an org");
  }

  bdd.acceptAgentStorageWrites();
  await bdd.readOnboardingStatus(actor);
  await bdd.setupOnboarding(actor, {
    displayName: "BDD Gmail Webhook Owner",
  });
  await grantVisibleCredits({ ...actor, orgId: actor.orgId });
  const agent = await bdd.createAgent(actor, {
    displayName: "gmail-webhook-agent",
    visibility: "private",
  });
  const workflow = await miscApi.createWorkflow(
    actor,
    agent.agentId,
    WORKFLOW_NAME,
    { content: "Handle Gmail webhook events." },
    [201],
  );
  if (!("id" in workflow.body)) {
    throw new Error(
      `Expected workflow creation to succeed, got ${JSON.stringify(
        workflow.body,
      )}`,
    );
  }
  return {
    actor: { ...actor, orgId: actor.orgId },
    workflowId: workflow.body.id,
  };
}

async function readTrigger(
  actor: ApiTestUser,
  triggerId: string,
): Promise<ZeroWorkflowTriggerSummary> {
  const response = await accept(
    triggersClient().get({
      headers: authHeaders(actor),
      params: { id: triggerId },
    }),
    [200],
  );
  return response.body;
}

async function runTriggerNow(
  actor: ApiTestUser,
  triggerId: string,
): Promise<{ readonly chatThreadId: string; readonly runId: string }> {
  const response = await createApp({ signal: context.signal }).request(
    `/api/zero/workflow-triggers/${triggerId}/run`,
    {
      method: "POST",
      headers: authHeaders(actor),
    },
  );
  const body = (await response.json()) as unknown;
  if (response.status !== 201) {
    expectApiError(body);
    throw new Error(
      `Expected trigger run to start, received ${response.status}: ${JSON.stringify(
        body,
      )}`,
    );
  }
  return body as { readonly chatThreadId: string; readonly runId: string };
}

function requireTriggerChatThreadId(
  trigger: ZeroWorkflowTriggerSummary,
): string {
  if (!trigger.chatThreadId) {
    throw new Error(`Expected trigger ${trigger.id} to have a chat thread`);
  }
  return trigger.chatThreadId;
}

async function workflowTriggerBriefs(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<readonly (string | null | undefined)[]> {
  const { messages } = await chatApi.listThreadMessages(actor, chatThreadId, {
    limit: 20,
  });
  return messages
    .filter((message) => {
      return message.role === "user";
    })
    .map((message) => {
      return message.workflowSnapshot?.triggerBrief;
    });
}

describe("POST /api/webhooks/gmail", () => {
  it("dispatches matching new inbound messages and de-duplicates retries", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailMessageMocks(gmailEmail);

    const { actor, workflowId } = await setupFixture();
    await enableGmailWorkflowTriggers(actor);
    await connectGmail(actor, gmailEmail);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: { subject: { contains: "invoice" } },
          },
        },
      }),
      [201],
    );
    const chatThreadId = requireTriggerChatThreadId(created.body);
    await configureWorkspaceModelProvider(actor);

    const body = gmailPushBody({
      emailAddress: gmailEmail,
      historyId: 101,
      messageId: "pubsub-1",
    });
    const first = await postGmailWebhook(body);

    expectResponseStatus(first, 200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    const expectedTriggerBrief = [
      "Gmail new message",
      "From: Customer Example <customer@example.com>",
      "Subject: Invoice needs a reply",
    ].join("\n");

    await expect(workflowTriggerBriefs(actor, chatThreadId)).resolves.toContain(
      expectedTriggerBrief,
    );
    await expect(readTrigger(actor, created.body.id)).resolves.toMatchObject({
      lastRunAt: expect.any(String),
    });
    const timingEvents = sandboxOperationEvents().filter((event) => {
      return event.workflow_event_source === "gmail";
    });
    const timingRunIds = new Set(
      timingEvents.map((event) => {
        return event.run_id;
      }),
    );
    expect(timingRunIds.size).toBe(1);
    expect([...timingRunIds][0]).toStrictEqual(expect.any(String));
    const actionTypes = new Set(
      timingEvents.map((event) => {
        return event.op_type;
      }),
    );
    for (const actionType of [
      "api_dispatch_pre_create_zero_workflow_trigger_entrypoint_gap",
      "api_dispatch_pre_create_zero_workflow_event_load_source_state",
      "api_dispatch_pre_create_zero_workflow_event_load_external_events",
      "api_dispatch_pre_create_zero_workflow_event_load_triggers",
      "api_dispatch_pre_create_zero_workflow_event_check_feature_gate",
      "api_dispatch_pre_create_zero_workflow_event_match_triggers",
      "api_dispatch_pre_create_zero_workflow_event_record_processed_event",
      "api_dispatch_pre_create_zero_workflow_event_build_run_input",
      "api_dispatch_pre_create_zero_workflow_event_handoff_run",
    ]) {
      expect(actionTypes).toContain(actionType);
    }
    expect(timingEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_workflow_event_handoff_run",
          workflow_event_source: "gmail",
          trigger_source: "workflow-event",
          zero_run_origin: "workflow_trigger",
          span_kind: "nested",
        }),
      ]),
    );
    const serializedTiming = JSON.stringify(timingEvents);
    expect(serializedTiming).not.toContain(gmailEmail);
    expect(serializedTiming).not.toContain("pubsub-1");
    expect(serializedTiming).not.toContain("msg-1");
    expect(serializedTiming).not.toContain("gmail-thread-1");
    expect(serializedTiming).not.toContain("customer@example.com");
    expect(serializedTiming).not.toContain("Invoice needs a reply");
    expect(serializedTiming).not.toContain("Please draft a helpful reply.");
    expect(serializedTiming).not.toContain(created.body.id);
    expect(serializedTiming).not.toContain(WORKFLOW_NAME);

    const second = await postGmailWebhook(body);

    expectResponseStatus(second, 200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 1,
    });
    const triggerBriefsAfterDuplicate = await workflowTriggerBriefs(
      actor,
      chatThreadId,
    );
    expect(
      triggerBriefsAfterDuplicate.filter((brief) => {
        return brief === expectedTriggerBrief;
      }),
    ).toHaveLength(1);
  });

  it("dispatches label applied events after refreshing a recreated label id", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailLabelsMockSequence([
      [{ id: "Label_support_old", name: "Support" }],
      [{ id: "Label_support_new", name: "Support" }],
    ]);
    configureGmailLabelAppliedMocks("Label_support_new", gmailEmail);

    const { actor, workflowId } = await setupFixture();
    await enableGmailWorkflowTriggers(actor);
    await connectGmail(actor, gmailEmail);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Support",
          },
        },
      }),
      [201],
    );
    const chatThreadId = requireTriggerChatThreadId(created.body);
    await configureWorkspaceModelProvider(actor);

    expect(created.body).toMatchObject({
      eventType: "gmail-label-applied",
      eventConfig: {
        labelName: "Support",
        resolvedLabelId: "Label_support_old",
      },
    });

    const first = await postGmailWebhook(
      gmailPushBody({
        emailAddress: gmailEmail,
        historyId: 102,
        messageId: "pubsub-label-1",
      }),
    );

    expectResponseStatus(first, 200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    await expect(workflowTriggerBriefs(actor, chatThreadId)).resolves.toContain(
      [
        "Gmail label applied: Support",
        "From: Support Team <support@example.com>",
        "Subject: Support request",
      ].join("\n"),
    );
    await expect(readTrigger(actor, created.body.id)).resolves.toMatchObject({
      eventConfig: {
        labelName: "Support",
        resolvedLabelId: "Label_support_new",
      },
      lastRunAt: expect.any(String),
    });
  });

  it("starts an event run when the trigger's previous run is still active", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailMessageMocks(gmailEmail);

    const { actor, workflowId } = await setupFixture();
    await enableGmailWorkflowTriggers(actor);
    await connectGmail(actor, gmailEmail);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: { subject: { contains: "invoice" } },
          },
        },
      }),
      [201],
    );
    const chatThreadId = requireTriggerChatThreadId(created.body);
    await configureWorkspaceModelProvider(actor);
    const activeRun = await runTriggerNow(actor, created.body.id);
    expect(activeRun.chatThreadId).toBe(chatThreadId);
    const triggerBriefsBeforeWebhook = await workflowTriggerBriefs(
      actor,
      chatThreadId,
    );

    const response = await postGmailWebhook(
      gmailPushBody({
        emailAddress: gmailEmail,
        historyId: 101,
        messageId: "pubsub-active-run",
      }),
    );

    expectResponseStatus(response, 200);
    expect(response.body).toMatchObject({ dispatched: 1, duplicates: 0 });

    const expectedTriggerBrief = [
      "Gmail new message",
      "From: Customer Example <customer@example.com>",
      "Subject: Invoice needs a reply",
    ].join("\n");
    const triggerBriefsAfterWebhook = await workflowTriggerBriefs(
      actor,
      chatThreadId,
    );
    expect(triggerBriefsAfterWebhook).toContain(expectedTriggerBrief);
    expect(triggerBriefsAfterWebhook).toHaveLength(
      triggerBriefsBeforeWebhook.length + 1,
    );
    await expect(readTrigger(actor, created.body.id)).resolves.toMatchObject({
      lastRunAt: expect.any(String),
    });
  });
});
