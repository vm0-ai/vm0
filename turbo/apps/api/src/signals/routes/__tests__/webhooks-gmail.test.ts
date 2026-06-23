import { Buffer } from "node:buffer";

import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@vm0/db/schema/gmail-event";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
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
        expect(new URL(request.url).searchParams.get("historyTypes")).toBe(
          "messageAdded",
        );
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
          snippet: "Need help with the invoice",
          payload: {
            mimeType: "multipart/alternative",
            headers: [
              { name: "From", value: "customer@example.com" },
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
  await store
    .set(writeDb$)
    .insert(userFeatureSwitches)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.WorkflowGmailEventTriggers]: true },
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
  return { fixture, workflowId: workflow.id };
}

describe("POST /api/webhooks/gmail", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    const db = store.set(writeDb$);
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
});
