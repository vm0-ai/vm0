import { Buffer } from "node:buffer";

import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { connectors } from "@vm0/db/schema/connector";
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@vm0/db/schema/gmail-event";
import { secrets } from "@vm0/db/schema/secret";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { encryptStoredSecretValue } from "../../services/crypto.utils";
import {
  setGmailPubSubOidcVerifierForTests,
  setGmailWorkflowRunStarterForTests,
  type GmailWorkflowRunStartTestInput,
} from "../../services/gmail-workflow-event.service";
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

const WORKFLOW_NAME = "gmail-webhook-workflow";
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const GMAIL_EMAIL = "webhook-user@example.com";
const GMAIL_AUDIENCE = "https://api.vm0.ai/api/webhooks/gmail";
const GMAIL_PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

function configureGmailEnv(): void {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
  mockOptionalEnv("GMAIL_PUBSUB_PUSH_AUDIENCE", GMAIL_AUDIENCE);
  mockOptionalEnv(
    "GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    GMAIL_PUSH_SERVICE_ACCOUNT,
  );
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
        authorization: "Bearer oidc-token",
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

async function seedGmailConnector(fixture: WorkflowsFixture): Promise<string> {
  const db = store.set(writeDb$);
  const [connector] = await db
    .insert(connectors)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "gmail",
      authMethod: "oauth",
      externalEmail: GMAIL_EMAIL,
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
    })
    .returning({ id: connectors.id });
  if (!connector) {
    throw new Error("Expected Gmail connector to be created");
  }

  await db.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "GMAIL_ACCESS_TOKEN",
    encryptedValue: await encryptStoredSecretValue("gmail-access-token"),
    type: "connector",
  });
  return connector.id;
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
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
  const [workflow] = await store
    .set(writeDb$)
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, fixture.orgId),
        eq(zeroWorkflows.agentId, agentId),
        eq(zeroWorkflows.name, WORKFLOW_NAME),
      ),
    );
  if (!workflow) {
    throw new Error("Expected the agent to own the seeded workflow");
  }
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  return { fixture, agentId, workflowId: workflow.id };
}

async function markTriggerWithActiveRun(args: {
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
  readonly triggerId: string;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: args.fixture.userId,
      orgId: args.fixture.orgId,
      agentComposeId: args.agentId,
    })
    .returning({ id: agentSessions.id });
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: args.fixture.userId,
      orgId: args.fixture.orgId,
      sessionId: session!.id,
      status: "running",
      prompt: "active event run",
    })
    .returning({ id: agentRuns.id });

  await db
    .update(zeroWorkflowTriggers)
    .set({ lastRunId: run!.id })
    .where(eq(zeroWorkflowTriggers.id, args.triggerId));

  return run!.id;
}

describe("POST /api/webhooks/gmail", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    const db = store.set(writeDb$);
    await deleteFeatureSwitchesForUser(context, fixture);
    await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
    await db.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
    await store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("dispatches matching new inbound messages and de-duplicates retries", async () => {
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailMessageMocks();

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGmailWorkflowTriggers(fixture);
    const connectorId = await seedGmailConnector(fixture);

    const restoreOidcVerifier = setGmailPubSubOidcVerifierForTests(
      (token, audience) => {
        expect(token).toBe("oidc-token");
        expect(audience).toBe(GMAIL_AUDIENCE);
        return Promise.resolve({
          email: GMAIL_PUSH_SERVICE_ACCOUNT,
          emailVerified: true,
        });
      },
    );

    const runCalls: GmailWorkflowRunStartTestInput[] = [];
    const restoreRunStarter = setGmailWorkflowRunStarterForTests((input) => {
      runCalls.push(input);
      return Promise.resolve("ok");
    });
    onTestFinished(() => {
      restoreRunStarter();
      restoreOidcVerifier();
    });

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
    expect(runCalls).toStrictEqual([
      {
        triggerId: created.body.id,
        workflowName: WORKFLOW_NAME,
        emailAddress: GMAIL_EMAIL,
        messageId: "msg-1",
        threadId: "gmail-thread-1",
        subject: "Invoice needs a reply",
        triggerBrief: [
          "Gmail new message",
          "From: Customer Example <customer@example.com>",
          "Subject: Invoice needs a reply",
        ].join("\n"),
      },
    ]);

    const db = store.set(writeDb$);
    const processed = await db
      .select({
        historyId: gmailProcessedEvents.historyId,
        messageId: gmailProcessedEvents.messageId,
      })
      .from(gmailProcessedEvents)
      .where(eq(gmailProcessedEvents.triggerId, created.body.id));
    expect(processed).toStrictEqual([{ historyId: "101", messageId: "msg-1" }]);

    const [watch] = await db
      .select({ lastHistoryId: gmailWatchStates.lastHistoryId })
      .from(gmailWatchStates)
      .where(eq(gmailWatchStates.connectorId, connectorId));
    expect(watch?.lastHistoryId).toBe("101");

    const second = await postGmailWebhook(body);

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 1,
    });
    expect(runCalls).toHaveLength(1);
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
    await seedGmailConnector(fixture);

    const restoreOidcVerifier = setGmailPubSubOidcVerifierForTests(() => {
      return Promise.resolve({
        email: GMAIL_PUSH_SERVICE_ACCOUNT,
        emailVerified: true,
      });
    });

    const runCalls: GmailWorkflowRunStartTestInput[] = [];
    const restoreRunStarter = setGmailWorkflowRunStarterForTests((input) => {
      runCalls.push(input);
      return Promise.resolve("ok");
    });
    onTestFinished(() => {
      restoreRunStarter();
      restoreOidcVerifier();
    });

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
    expect(runCalls).toStrictEqual([
      {
        triggerId: created.body.id,
        workflowName: WORKFLOW_NAME,
        emailAddress: GMAIL_EMAIL,
        messageId: "msg-labeled",
        threadId: "gmail-thread-labeled",
        subject: "Support request",
        triggerBrief: [
          "Gmail label applied: Support",
          "From: Support Team <support@example.com>",
          "Subject: Support request",
        ].join("\n"),
      },
    ]);

    const [triggerRow] = await store
      .set(writeDb$)
      .select({ eventConfig: zeroWorkflowTriggers.eventConfig })
      .from(zeroWorkflowTriggers)
      .where(eq(zeroWorkflowTriggers.id, created.body.id));
    expect(triggerRow?.eventConfig).toMatchObject({
      labelName: "Support",
      resolvedLabelId: "Label_support_new",
    });
  });

  it("starts an event run when the trigger's previous run is still active", async () => {
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailMessageMocks();

    const { fixture, agentId, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGmailWorkflowTriggers(fixture);
    await seedGmailConnector(fixture);

    const restoreOidcVerifier = setGmailPubSubOidcVerifierForTests(() => {
      return Promise.resolve({
        email: GMAIL_PUSH_SERVICE_ACCOUNT,
        emailVerified: true,
      });
    });
    onTestFinished(() => {
      restoreOidcVerifier();
    });

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
    const activeRunId = await markTriggerWithActiveRun({
      fixture,
      agentId,
      triggerId: created.body.id,
    });

    const response = await postGmailWebhook(
      gmailPushBody({
        emailAddress: GMAIL_EMAIL,
        historyId: 101,
        messageId: "pubsub-active-run",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ dispatched: 1, duplicates: 0 });

    const db = store.set(writeDb$);
    const runs = await db
      .select({
        id: zeroRuns.id,
        triggerSource: zeroRuns.triggerSource,
        triggerBrief: zeroRuns.triggerBrief,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.workflowTriggerId, created.body.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("workflow-event");
    expect(runs[0]?.triggerBrief).toBe(
      [
        "Gmail new message",
        "From: Customer Example <customer@example.com>",
        "Subject: Invoice needs a reply",
      ].join("\n"),
    );

    const userMessages = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(
        and(eq(chatMessages.runId, runs[0]!.id), eq(chatMessages.role, "user")),
      );
    expect(userMessages).toStrictEqual([{ content: `/${WORKFLOW_NAME}` }]);

    const [trigger] = await db
      .select({
        lastRunId: zeroWorkflowTriggers.lastRunId,
        lastRunAt: zeroWorkflowTriggers.lastRunAt,
      })
      .from(zeroWorkflowTriggers)
      .where(eq(zeroWorkflowTriggers.id, created.body.id));
    expect(trigger?.lastRunId).toBe(activeRunId);
    expect(trigger?.lastRunAt).toBeInstanceOf(Date);
  });
});
