import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync } from "node:crypto";

import { chatThreadMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroWorkflowTriggersContract,
  zeroWorkflowsCollectionContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  deleteWorkflowsForFixture$,
  seedAgentForInstructions$,
  seedWorkflowsFixture$,
  type WorkflowsFixture,
} from "./helpers/zero-workflows";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const connectorsApi = createConnectorBddApi(context);

const WORKFLOW_NAME = "gmail-webhook-workflow";
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const GMAIL_EMAIL = "webhook-user@example.com";
const GMAIL_AUDIENCE = "https://api.vm0.ai/api/webhooks/gmail";
const GMAIL_PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";
const GOOGLE_OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const GOOGLE_OIDC_KID = "gmail-pubsub-test-key";
const googleOidcKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function base64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function signGooglePubSubOidcToken(): string {
  const seconds = Math.floor(now() / 1000);
  const header = base64Url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: GOOGLE_OIDC_KID }),
  );
  const payload = base64Url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub: "gmail-pubsub-test-subject",
      aud: GMAIL_AUDIENCE,
      email: GMAIL_PUSH_SERVICE_ACCOUNT,
      email_verified: true,
      iat: seconds,
      exp: seconds + 60 * 60,
    }),
  );
  const signed = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signed)
    .sign(googleOidcKeyPair.privateKey);
  return `${signed}.${base64Url(signature)}`;
}

function configureGoogleOidcCertMock(): void {
  server.use(
    http.get(GOOGLE_OIDC_CERTS_URL, () => {
      return HttpResponse.json(
        {
          [GOOGLE_OIDC_KID]: googleOidcKeyPair.publicKey.export({
            type: "spki",
            format: "pem",
          }),
        },
        { headers: { "cache-control": "no-cache" } },
      );
    }),
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

function workflowsClient() {
  return setupApp({ context })(zeroWorkflowsCollectionContract);
}

function chatThreadMessagesClient() {
  return setupApp({ context })(chatThreadMessagesContract);
}

function actorForFixture(fixture: WorkflowsFixture): ApiTestUser {
  return {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: GMAIL_EMAIL,
  };
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

function gmailBodyData(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function configureGmailMessageMocks(): void {
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
              { name: "To", value: GMAIL_EMAIL },
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

function configureGmailLabelAppliedMocks(labelId: string): void {
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
              { name: "To", value: GMAIL_EMAIL },
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
        authorization: `Bearer ${signGooglePubSubOidcToken()}`,
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

async function enableGmailWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowGmailEventTriggers]: true,
  });
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

async function connectGmailConnector(fixture: WorkflowsFixture): Promise<void> {
  mockGmailConnectorOAuth({ email: GMAIL_EMAIL });
  const actor = actorForFixture(fixture);
  const start = await connectorsApi.startOauth(actor, "gmail", "oauth");
  await connectorsApi.completeOauthCallback("gmail", {
    code: "gmail-webhook-code",
    state: stateFromAuthorizationUrl(start.authorizationUrl),
  });
  const connector = await connectorsApi.readConnectorByType(actor, "gmail");
  expect(connector).toMatchObject({
    type: "gmail",
    authMethod: "oauth",
    externalEmail: GMAIL_EMAIL,
    connectionStatus: "connected",
  });
}

async function readTrigger(triggerId: string) {
  const response = await accept(
    triggersClient().get({
      headers: authHeaders(),
      params: { id: triggerId },
    }),
    [200],
  );
  return response.body;
}

async function workflowMessagesForTrigger(triggerId: string) {
  const trigger = await readTrigger(triggerId);
  const threadId = trigger.chatThreadId;
  if (!threadId) {
    return [];
  }
  const response = await accept(
    chatThreadMessagesClient().list({
      headers: authHeaders(),
      params: { threadId },
      query: { limit: 50 },
    }),
    [200],
  );
  return response.body.messages.filter((message) => {
    return (
      message.role === "user" &&
      message.workflowSnapshot?.triggerId === triggerId
    );
  });
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly workflowId: string;
}> {
  const fixture = await store.set(
    seedWorkflowsFixture$,
    undefined,
    context.signal,
  );
  context.mocks.s3.send.mockResolvedValue({});
  const { agentId } = await store.set(
    seedAgentForInstructions$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "gmail-webhook-agent",
      workflowNames: [WORKFLOW_NAME],
      composeContent: {
        version: "1",
        agents: {
          "gmail-webhook-agent": {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
    },
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  const workflows = await accept(
    workflowsClient().list({
      headers: authHeaders(),
      query: { agentId },
    }),
    [200],
  );
  const workflow = workflows.body.find((item) => {
    return item.name === WORKFLOW_NAME;
  });
  if (!workflow) {
    throw new Error("Expected the agent to own the seeded workflow");
  }
  return { fixture, workflowId: workflow.id };
}

describe("POST /api/webhooks/gmail", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    await deleteFeatureSwitchesForUser(context, fixture);
    await connectorsApi.deleteConnectorByType(
      actorForFixture(fixture),
      "gmail",
      [204, 404],
    );
    await store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("dispatches matching new inbound messages and de-duplicates retries", async () => {
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailMessageMocks();

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGmailWorkflowTriggers(fixture);
    await connectGmailConnector(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
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

    const body = gmailPushBody({
      emailAddress: GMAIL_EMAIL,
      historyId: 101,
      messageId: "pubsub-1",
    });
    const first = await postGmailWebhook(body);

    expect(first.status).toBe(200);
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

    const messagesAfterFirst = await workflowMessagesForTrigger(
      created.body.id,
    );
    expect(messagesAfterFirst).toHaveLength(1);
    expect(messagesAfterFirst[0]).toMatchObject({
      role: "user",
      content: `/${WORKFLOW_NAME}`,
      triggerSource: "workflow-event",
      workflowSnapshot: {
        triggerId: created.body.id,
        triggerBrief: expectedTriggerBrief,
      },
    });

    const second = await postGmailWebhook(body);

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 1,
    });
    await expect(
      workflowMessagesForTrigger(created.body.id),
    ).resolves.toHaveLength(1);
  });

  it("dispatches label applied events after refreshing a recreated label id", async () => {
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailLabelsMockSequence([
      [{ id: "Label_support_old", name: "Support" }],
      [{ id: "Label_support_new", name: "Support" }],
    ]);
    configureGmailLabelAppliedMocks("Label_support_new");

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGmailWorkflowTriggers(fixture);
    await connectGmailConnector(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
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

    expect(created.body).toMatchObject({
      eventType: "gmail-label-applied",
      eventConfig: {
        labelName: "Support",
        resolvedLabelId: "Label_support_old",
      },
    });

    const first = await postGmailWebhook(
      gmailPushBody({
        emailAddress: GMAIL_EMAIL,
        historyId: 102,
        messageId: "pubsub-label-1",
      }),
    );

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    const expectedTriggerBrief = [
      "Gmail label applied: Support",
      "From: Support Team <support@example.com>",
      "Subject: Support request",
    ].join("\n");
    const labelMessages = await workflowMessagesForTrigger(created.body.id);
    expect(labelMessages).toHaveLength(1);
    expect(labelMessages[0]).toMatchObject({
      role: "user",
      content: `/${WORKFLOW_NAME}`,
      triggerSource: "workflow-event",
      workflowSnapshot: {
        triggerId: created.body.id,
        triggerBrief: expectedTriggerBrief,
      },
    });

    const updatedTrigger = await readTrigger(created.body.id);
    if (
      !("eventType" in updatedTrigger) ||
      updatedTrigger.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected a Gmail label trigger");
    }
    expect(updatedTrigger.eventConfig).toMatchObject({
      labelName: "Support",
      resolvedLabelId: "Label_support_new",
    });
  });

  it("starts an event run when the trigger's previous run is still active", async () => {
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailMessageMocks();

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGmailWorkflowTriggers(fixture);
    await connectGmailConnector(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
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
    const initialRun = await accept(
      triggersClient().run({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [201],
    );
    expect(initialRun.body.chatThreadId).toBe(created.body.chatThreadId);

    const response = await postGmailWebhook(
      gmailPushBody({
        emailAddress: GMAIL_EMAIL,
        historyId: 101,
        messageId: "pubsub-active-run",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dispatched: 1, duplicates: 0 });

    const messages = await workflowMessagesForTrigger(created.body.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.runId).toBe(initialRun.body.runId);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: `/${WORKFLOW_NAME}`,
      triggerSource: "workflow-event",
      workflowSnapshot: {
        triggerId: created.body.id,
        triggerBrief: [
          "Gmail new message",
          "From: Customer Example <customer@example.com>",
          "Subject: Invoice needs a reply",
        ].join("\n"),
      },
    });

    const trigger = await readTrigger(created.body.id);
    expect(trigger.lastRunAt).not.toBeNull();
  });
});
