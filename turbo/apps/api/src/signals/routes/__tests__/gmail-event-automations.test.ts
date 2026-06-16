import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { automationsMainContract } from "@vm0/api-contracts/contracts/automations";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations } from "@vm0/db/schema/automation";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@vm0/db/schema/gmail-event";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { setGmailPubSubOidcVerifierForTests } from "../../services/gmail-event.service";
import {
  type AutomationsFixture,
  deleteAutomationsScenario$,
  seedAutomationsScenario$,
} from "./helpers/automations";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const SESSION_HEADERS = { authorization: "Bearer clerk-session" } as const;
const TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-label-events";
const PUSH_AUDIENCE = "https://api.vm0.ai/api/webhooks/gmail";
const PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";
const CRON_SECRET = "gmail-renew-cron-secret";
const GMAIL_EMAIL = "user@example.test";
const GMAIL_ACCESS_TOKEN = "gmail-access-token";
const GMAIL_REFRESH_TOKEN = "gmail-refresh-token";
const LABEL_ID = "Label_123";
const LABEL_NAME = "Needs Reply";
const WATCH_EXPIRATION = "2030-01-02T03:04:05.000Z";

afterEach(() => {
  resetSecretKmsClientForTests();
});

const trackAutomations = createFixtureTracker<AutomationsFixture>((fixture) => {
  return store.set(deleteAutomationsScenario$, fixture, context.signal);
});

const trackCreatedAutomations = createFixtureTracker<AutomationsFixture>(
  async (fixture) => {
    const db = store.set(writeDb$);
    const rows = await db
      .select({ id: automations.id, chatThreadId: automations.chatThreadId })
      .from(automations)
      .where(eq(automations.orgId, fixture.orgId));
    for (const row of rows) {
      await db.delete(automations).where(eq(automations.id, row.id));
      await db.delete(chatThreads).where(eq(chatThreads.id, row.chatThreadId));
    }
  },
);

function mainApi() {
  return setupApp({ context })(automationsMainContract);
}

async function seedFixture(): Promise<AutomationsFixture> {
  configureGmailEventTestEnv();
  const fixture = await trackAutomations(
    store.set(seedAutomationsScenario$, { automations: [] }, context.signal),
  );
  await trackCreatedAutomations(Promise.resolve(fixture));
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

function configureGmailEventTestEnv(): void {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", TOPIC_NAME);
  mockOptionalEnv("GMAIL_PUBSUB_PUSH_AUDIENCE", PUSH_AUDIENCE);
  mockOptionalEnv(
    "GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    PUSH_SERVICE_ACCOUNT,
  );
  mockEnv("CRON_SECRET", CRON_SECRET);
  context.mocks.s3.send.mockResolvedValue({});
  setSecretKmsClientForTests(fakeKmsClient().client);
}

async function enableGmailEventTriggers(
  fixture: AutomationsFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: {
      [FeatureSwitchKey.AutomationGmailEventTriggers]: true,
    },
  });
}

async function seedGmailConnector(
  fixture: AutomationsFixture,
): Promise<string> {
  const db = store.set(writeDb$);
  const [connector] = await db
    .insert(connectors)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "gmail",
      authMethod: "oauth",
      externalId: "gmail-user-id",
      externalUsername: "Gmail User",
      externalEmail: GMAIL_EMAIL,
      oauthScopes: JSON.stringify([
        "https://www.googleapis.com/auth/gmail.modify",
      ]),
      tokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      needsReconnect: false,
    })
    .returning({ id: connectors.id });
  if (!connector) {
    throw new Error("Expected Gmail connector row");
  }

  await db.insert(secrets).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "connector",
      name: "GMAIL_ACCESS_TOKEN",
      encryptedValue: encryptSecretForTests(GMAIL_ACCESS_TOKEN),
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "connector",
      name: "GMAIL_REFRESH_TOKEN",
      encryptedValue: encryptSecretForTests(GMAIL_REFRESH_TOKEN),
    },
  ]);

  return connector.id;
}

function registerGmailApiMocks(options?: {
  readonly watchHistoryId?: string;
  readonly historyResponse?: Record<string, unknown>;
}): {
  readonly watchCalls: () => number;
  readonly historyCalls: () => number;
  readonly messageCalls: () => number;
} {
  let watchCalls = 0;
  let historyCalls = 0;
  let messageCalls = 0;
  const watchHistoryId = options?.watchHistoryId ?? "100";
  const historyResponse =
    options?.historyResponse ??
    ({
      history: [
        {
          id: "201",
          labelsAdded: [
            {
              message: { id: "msg-1", threadId: "thread-1" },
              labelIds: [LABEL_ID],
            },
          ],
        },
      ],
      historyId: "202",
    } satisfies Record<string, unknown>);

  server.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      async ({ request }) => {
        watchCalls++;
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${GMAIL_ACCESS_TOKEN}`,
        );
        expect((await request.json()) as unknown).toStrictEqual({
          topicName: TOPIC_NAME,
        });
        return HttpResponse.json({
          historyId: watchHistoryId,
          expiration: String(Date.parse(WATCH_EXPIRATION)),
        });
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
      ({ request }) => {
        historyCalls++;
        const url = new URL(request.url);
        expect(url.searchParams.get("historyTypes")).toBe("labelAdded");
        return HttpResponse.json(historyResponse);
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId",
      ({ request }) => {
        messageCalls++;
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${GMAIL_ACCESS_TOKEN}`,
        );
        return HttpResponse.json({
          id: "msg-1",
          threadId: "thread-1",
          snippet: "Can you send a quick reply?",
          payload: {
            headers: [
              { name: "From", value: "Customer <customer@example.test>" },
              { name: "Subject", value: "Follow-up request" },
            ],
          },
        });
      },
    ),
  );

  return {
    watchCalls: () => {
      return watchCalls;
    },
    historyCalls: () => {
      return historyCalls;
    },
    messageCalls: () => {
      return messageCalls;
    },
  };
}

async function createGmailLabelAutomation(fixture: AutomationsFixture) {
  return await accept(
    mainApi().create({
      headers: SESSION_HEADERS,
      body: {
        name: `gmail-label-${randomUUID().slice(0, 8)}`,
        agentId: fixture.composeId,
        instruction: "Read the labeled email and draft a reply.",
        description: "Draft Gmail replies from a label",
        appendSystemPrompt: "Use a concise, professional tone.",
        trigger: {
          kind: "event",
          config: {
            provider: "gmail",
            event: "label_applied",
            labelId: LABEL_ID,
            labelName: LABEL_NAME,
          },
        },
      },
    }),
    [201],
  );
}

function trustPubSubToken(): void {
  const clearPubSubVerifier = setGmailPubSubOidcVerifierForTests(
    (token, audience) => {
      expect(token).toBe("pubsub-token");
      expect(audience).toBe(PUSH_AUDIENCE);
      return Promise.resolve({
        email: PUSH_SERVICE_ACCOUNT,
        emailVerified: true,
      });
    },
  );
  onTestFinished(() => {
    clearPubSubVerifier();
  });
}

function pubSubPushBody(args: {
  readonly messageId: string;
  readonly emailAddress: string;
  readonly historyId: string;
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
    subscription:
      "projects/vm0-ai-488909/subscriptions/gmail-label-events-push",
  });
}

async function postGmailPubSubPush(rawBody: string): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/webhooks/gmail", {
    method: "POST",
    headers: {
      authorization: "Bearer pubsub-token",
      "content-type": "application/json",
    },
    body: rawBody,
  });
}

describe("Gmail event automations", () => {
  it("creates a Gmail label trigger, registers a watch, and enables the Gmail connector for the agent", async () => {
    const fixture = await seedFixture();
    await enableGmailEventTriggers(fixture);
    await seedGmailConnector(fixture);
    const gmail = registerGmailApiMocks();

    const created = await createGmailLabelAutomation(fixture);
    const [trigger] = created.body.automation.triggers;
    if (trigger?.kind !== "event") {
      throw new Error("Expected Gmail event trigger");
    }
    expect(trigger.config).toStrictEqual({
      provider: "gmail",
      event: "label_applied",
      labelId: LABEL_ID,
      labelName: LABEL_NAME,
    });
    expect(gmail.watchCalls()).toBe(1);

    const db = store.set(writeDb$);
    const [watchState] = await db
      .select({
        emailAddress: gmailWatchStates.emailAddress,
        topicName: gmailWatchStates.topicName,
        lastHistoryId: gmailWatchStates.lastHistoryId,
        watchExpirationAt: gmailWatchStates.watchExpirationAt,
      })
      .from(gmailWatchStates)
      .where(eq(gmailWatchStates.orgId, fixture.orgId));
    expect(watchState).toStrictEqual({
      emailAddress: GMAIL_EMAIL,
      topicName: TOPIC_NAME,
      lastHistoryId: "100",
      watchExpirationAt: new Date(WATCH_EXPIRATION),
    });

    const [agentConnector] = await db
      .select({ connectorType: userConnectors.connectorType })
      .from(userConnectors)
      .where(eq(userConnectors.agentId, fixture.composeId));
    expect(agentConnector).toStrictEqual({ connectorType: "gmail" });
  });

  it("rejects Gmail event triggers when the switch is disabled or Gmail is not connected", async () => {
    const fixture = await seedFixture();

    const gated = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "gated-gmail",
          agentId: fixture.composeId,
          instruction: "Draft a reply.",
          trigger: {
            kind: "event",
            config: {
              provider: "gmail",
              event: "label_applied",
              labelId: LABEL_ID,
            },
          },
        },
      }),
      [400],
    );
    expect(gated.body.error.message).toContain("not enabled");

    await enableGmailEventTriggers(fixture);
    const missingConnector = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "missing-gmail",
          agentId: fixture.composeId,
          instruction: "Draft a reply.",
          trigger: {
            kind: "event",
            config: {
              provider: "gmail",
              event: "label_applied",
              labelId: LABEL_ID,
            },
          },
        },
      }),
      [400],
    );
    expect(missingConnector.body.error.message).toContain("Connect Gmail");
  });

  it("dispatches a verified Pub/Sub label event once and ignores duplicate retries", async () => {
    const fixture = await seedFixture();
    await enableGmailEventTriggers(fixture);
    await seedGmailConnector(fixture);
    const gmail = registerGmailApiMocks();
    const created = await createGmailLabelAutomation(fixture);
    const trigger = created.body.automation.triggers[0];
    if (trigger?.kind !== "event") {
      throw new Error("Expected Gmail event trigger");
    }

    trustPubSubToken();
    const pushBody = pubSubPushBody({
      messageId: "pubsub-1",
      emailAddress: GMAIL_EMAIL,
      historyId: "202",
    });
    const first = await postGmailPubSubPush(pushBody);
    expect(first.status).toBe(200);
    await expect(first.text()).resolves.toBe("OK");

    const db = store.set(writeDb$);
    const runs = await db
      .select({
        id: zeroRuns.id,
        triggerSource: zeroRuns.triggerSource,
        automationId: zeroRuns.automationId,
        triggerId: zeroRuns.triggerId,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.automationId, created.body.automation.id));
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toStrictEqual({
      id: run?.id,
      triggerSource: "gmail",
      automationId: created.body.automation.id,
      triggerId: trigger.id,
      chatThreadId: created.body.automation.chatThreadId,
    });

    const [agentRun] = await db
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, run!.id));
    expect(agentRun?.prompt).toBe("Read the labeled email and draft a reply.");
    expect(agentRun?.appendSystemPrompt).toContain("Gmail label automation");
    expect(agentRun?.appendSystemPrompt).toContain("Follow-up request");
    expect(agentRun?.appendSystemPrompt).toContain(LABEL_NAME);
    expect(agentRun?.appendSystemPrompt).toContain(
      "Use a concise, professional tone.",
    );

    const [chatMessage] = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        automationTitle: chatMessages.automationTitle,
      })
      .from(chatMessages)
      .where(eq(chatMessages.runId, run!.id));
    expect(chatMessage).toMatchObject({
      role: "user",
      content: "Read the labeled email and draft a reply.",
      automationTitle: created.body.automation.name,
    });

    const processed = await db
      .select({ id: gmailProcessedEvents.id })
      .from(gmailProcessedEvents)
      .where(eq(gmailProcessedEvents.triggerId, trigger.id));
    expect(processed).toHaveLength(1);
    expect(gmail.historyCalls()).toBe(1);
    expect(gmail.messageCalls()).toBe(1);

    const duplicate = await postGmailPubSubPush(pushBody);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.text()).resolves.toBe("OK");

    const afterDuplicateRuns = await db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(eq(zeroRuns.automationId, created.body.automation.id));
    const afterDuplicateProcessed = await db
      .select({ id: gmailProcessedEvents.id })
      .from(gmailProcessedEvents)
      .where(eq(gmailProcessedEvents.triggerId, trigger.id));
    expect(afterDuplicateRuns).toHaveLength(1);
    expect(afterDuplicateProcessed).toHaveLength(1);
    expect(gmail.historyCalls()).toBe(2);
    expect(gmail.messageCalls()).toBe(2);
  });

  it("rejects Pub/Sub pushes without verified OIDC", async () => {
    const fixture = await seedFixture();
    await enableGmailEventTriggers(fixture);

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/webhooks/gmail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: pubSubPushBody({
        messageId: "pubsub-missing-auth",
        emailAddress: GMAIL_EMAIL,
        historyId: "202",
      }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Unauthorized",
    });
  });

  it("renews expiring Gmail watches from the cron route", async () => {
    const fixture = await seedFixture();
    await enableGmailEventTriggers(fixture);
    const connectorId = await seedGmailConnector(fixture);
    const gmail = registerGmailApiMocks({ watchHistoryId: "300" });
    const db = store.set(writeDb$);
    await db.insert(gmailWatchStates).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorId,
      emailAddress: GMAIL_EMAIL,
      topicName: TOPIC_NAME,
      lastHistoryId: "99",
      watchExpirationAt: new Date("2026-01-01T00:00:00.000Z"),
      lastWatchRenewedAt: new Date("2025-12-31T00:00:00.000Z"),
      needsRewatch: true,
    });

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/cron/renew-gmail-watches", {
      method: "GET",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      renewed: 1,
      failed: 0,
    });
    expect(gmail.watchCalls()).toBe(1);

    const [watchState] = await db
      .select({
        lastHistoryId: gmailWatchStates.lastHistoryId,
        watchExpirationAt: gmailWatchStates.watchExpirationAt,
        needsRewatch: gmailWatchStates.needsRewatch,
      })
      .from(gmailWatchStates)
      .where(eq(gmailWatchStates.connectorId, connectorId));
    expect(watchState).toStrictEqual({
      lastHistoryId: "300",
      watchExpirationAt: new Date(WATCH_EXPIRATION),
      needsRewatch: false,
    });
  });
});
