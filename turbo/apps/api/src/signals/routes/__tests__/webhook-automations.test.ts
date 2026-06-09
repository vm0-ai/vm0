import { createHmac } from "node:crypto";

import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import {
  webhookAutomationCreateResponseSchema,
  webhookAutomationListResponseSchema,
} from "@vm0/api-contracts/contracts/webhook-automations";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { writeDb$ } from "../../external/db";
import {
  type SchedulesFixture,
  deleteSchedulesScenario$,
  seedSchedulesScenario$,
} from "./helpers/zero-schedules";
import { decryptSecretForTests } from "./helpers/encrypt-secret";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const SESSION_HEADERS = { authorization: "Bearer clerk-session" } as const;
const SIGNATURE_HEADER = "x-vm0-signature-256";

afterEach(() => {
  resetSecretKmsClientForTests();
});

const trackSchedules = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

// Webhook automations created through the API are not part of the schedule
// fixture, so delete them by their (orgId, userId) scope after each test. The
// trigger rows cascade with the automation; the linked chat threads are removed
// explicitly.
const trackCreatedAutomations = createFixtureTracker<SchedulesFixture>(
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

interface TestApiResponse {
  readonly status: number;
  readonly body: unknown;
}

async function requestJson(
  path: string,
  init: RequestInit,
): Promise<TestApiResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(path, init);
  return { status: response.status, body: await response.json() };
}

async function requestStatus(path: string, init: RequestInit): Promise<number> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(path, init);
  return response.status;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { ...SESSION_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function seedFixture(): Promise<SchedulesFixture> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.s3.send.mockResolvedValue({});
  setSecretKmsClientForTests(fakeKmsClient().client);
  const fixture = await trackSchedules(
    store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
  );
  await trackCreatedAutomations(Promise.resolve(fixture));
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function enableAutomations(fixture: SchedulesFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.ZeroAutomations]: true },
  });
}

function expectErrorCode(response: TestApiResponse): string {
  return apiErrorSchema.parse(response.body).error.code;
}

describe("Webhook automations management API", () => {
  it("creates a webhook automation, returns the url + secret once, and persists rows", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const response = await requestJson(
      "/api/automations/webhooks",
      jsonInit("POST", {
        name: "deploy-alerts",
        instruction: "Summarize the incoming deploy event.",
        description: "On deploy",
        agentId: fixture.composeId,
      }),
    );
    expect(response.status).toBe(201);

    const created = webhookAutomationCreateResponseSchema.parse(response.body);
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.automation.name).toBe("deploy-alerts");
    expect(created.automation.instruction).toBe(
      "Summarize the incoming deploy event.",
    );
    expect(created.automation.enabled).toBeTruthy();
    expect(created.automation.webhookToken).toMatch(/^whk_[0-9a-f]{48}$/);
    expect(created.automation.webhookUrl).toBe(
      `http://localhost:3000/api/automations/webhooks/${created.automation.webhookToken}`,
    );

    // The automation row persists on the new table with the webhook interpreter.
    const db = store.set(writeDb$);
    const [automationRow] = await db
      .select({
        orgId: automations.orgId,
        userId: automations.userId,
        name: automations.name,
        instruction: automations.instruction,
        interpreterKind: automations.interpreterKind,
        enabled: automations.enabled,
        chatThreadId: automations.chatThreadId,
      })
      .from(automations)
      .where(eq(automations.id, created.automation.id));
    expect(automationRow).toStrictEqual({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "deploy-alerts",
      instruction: "Summarize the incoming deploy event.",
      interpreterKind: "webhook",
      enabled: true,
      chatThreadId: created.automation.chatThreadId,
    });

    // A server-created chat thread is linked to the automation's agent.
    const [thread] = await db
      .select({
        userId: chatThreads.userId,
        agentComposeId: chatThreads.agentComposeId,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, created.automation.chatThreadId));
    expect(thread).toStrictEqual({
      userId: fixture.userId,
      agentComposeId: fixture.composeId,
    });

    // The trigger row carries the token and the ENCRYPTED secret — the returned
    // plaintext secret is never persisted as-is, but decrypts back to it.
    const [trigger] = await db
      .select({
        kind: automationTriggers.kind,
        webhookToken: automationTriggers.webhookToken,
        encryptedSecret: automationTriggers.encryptedSecret,
      })
      .from(automationTriggers)
      .where(eq(automationTriggers.automationId, created.automation.id));
    expect(trigger?.kind).toBe("webhook");
    expect(trigger?.webhookToken).toBe(created.automation.webhookToken);
    expect(trigger?.encryptedSecret).not.toBeNull();
    expect(trigger?.encryptedSecret).not.toContain(created.secret);
    expect(decryptSecretForTests(trigger!.encryptedSecret!)).toBe(
      created.secret,
    );
  });

  it("links an existing owned chat thread when chatThreadId is supplied", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const db = store.set(writeDb$);
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: fixture.userId,
        agentComposeId: fixture.composeId,
        title: "existing thread",
      })
      .returning({ id: chatThreads.id });

    const response = await requestJson(
      "/api/automations/webhooks",
      jsonInit("POST", {
        name: "linked",
        instruction: "Handle it.",
        agentId: fixture.composeId,
        chatThreadId: thread!.id,
      }),
    );
    expect(response.status).toBe(201);
    const created = webhookAutomationCreateResponseSchema.parse(response.body);
    expect(created.automation.chatThreadId).toBe(thread!.id);
  });

  it("rejects a chat thread that is not owned by the caller", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const db = store.set(writeDb$);
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: "user_someone_else",
        agentComposeId: fixture.composeId,
        title: "foreign thread",
      })
      .returning({ id: chatThreads.id });

    const response = await requestJson(
      "/api/automations/webhooks",
      jsonInit("POST", {
        name: "bad-link",
        instruction: "Handle it.",
        agentId: fixture.composeId,
        chatThreadId: thread!.id,
      }),
    );
    expect(response.status).toBe(400);
    expect(expectErrorCode(response)).toBe("BAD_REQUEST");

    await db.delete(chatThreads).where(eq(chatThreads.id, thread!.id));
  });

  it("returns 404 when the target agent is not visible", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const response = await requestJson(
      "/api/automations/webhooks",
      jsonInit("POST", {
        name: "no-agent",
        instruction: "Handle it.",
        agentId: "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(response.status).toBe(404);
    expect(expectErrorCode(response)).toBe("NOT_FOUND");
  });

  it("lists webhook automations without the secret", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const created = webhookAutomationCreateResponseSchema.parse(
      (
        await requestJson(
          "/api/automations/webhooks",
          jsonInit("POST", {
            name: "listed",
            instruction: "Summarize.",
            agentId: fixture.composeId,
          }),
        )
      ).body,
    );

    const listResponse = await requestJson("/api/automations/webhooks", {
      method: "GET",
      headers: SESSION_HEADERS,
    });
    expect(listResponse.status).toBe(200);
    const list = webhookAutomationListResponseSchema.parse(listResponse.body);
    expect(list.automations).toHaveLength(1);
    const [item] = list.automations;
    expect(item?.id).toBe(created.automation.id);
    expect(item?.webhookToken).toBe(created.automation.webhookToken);
    expect(item?.webhookUrl).toBe(created.automation.webhookUrl);
    // The secret is never present on the list projection.
    expect(Object.keys(item ?? {})).not.toContain("secret");
  });

  it("deletes a webhook automation and cascades the trigger", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const created = webhookAutomationCreateResponseSchema.parse(
      (
        await requestJson(
          "/api/automations/webhooks",
          jsonInit("POST", {
            name: "removable",
            instruction: "Summarize.",
            agentId: fixture.composeId,
          }),
        )
      ).body,
    );

    const delStatus = await requestStatus(
      `/api/automations/webhooks/${created.automation.id}`,
      { method: "DELETE", headers: SESSION_HEADERS },
    );
    expect(delStatus).toBe(204);

    const db = store.set(writeDb$);
    const automationRows = await db
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.id, created.automation.id));
    expect(automationRows).toHaveLength(0);
    const triggerRows = await db
      .select({ id: automationTriggers.id })
      .from(automationTriggers)
      .where(eq(automationTriggers.automationId, created.automation.id));
    expect(triggerRows).toHaveLength(0);
  });

  it("returns 404 deleting an automation owned by another scope", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const delStatus = await requestStatus(
      "/api/automations/webhooks/00000000-0000-0000-0000-000000000000",
      { method: "DELETE", headers: SESSION_HEADERS },
    );
    expect(delStatus).toBe(404);
  });

  it("accepts the minted token at the inbound webhook route end-to-end", async () => {
    const fixture = await seedFixture();
    await enableAutomations(fixture);

    const created = webhookAutomationCreateResponseSchema.parse(
      (
        await requestJson(
          "/api/automations/webhooks",
          jsonInit("POST", {
            name: "end-to-end",
            instruction: "Summarize the incoming webhook event.",
            agentId: fixture.composeId,
          }),
        )
      ).body,
    );

    const body = JSON.stringify({ event: "ping", value: 7 });
    const signature = `sha256=${createHmac("sha256", created.secret)
      .update(body)
      .digest("hex")}`;

    const app = createApp({ signal: context.signal });
    const inbound = await app.request(
      `/api/automations/webhooks/${created.automation.webhookToken}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signature,
        },
        body,
      },
    );
    expect(inbound.status).toBe(200);

    // The inbound dispatch created a webhook-sourced run on the linked thread.
    const db = store.set(writeDb$);
    const [run] = await db
      .select({
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.chatThreadId, created.automation.chatThreadId));
    expect(run).toStrictEqual({
      triggerSource: "webhook",
      chatThreadId: created.automation.chatThreadId,
    });
  });
});

describe("Webhook automations management feature gating", () => {
  it("returns 404 on every endpoint when the switch is off", async () => {
    const fixture = await seedFixture();

    const create = await requestJson(
      "/api/automations/webhooks",
      jsonInit("POST", {
        name: "blocked",
        instruction: "Should not be created.",
        agentId: fixture.composeId,
      }),
    );
    expect(create.status).toBe(404);
    expect(expectErrorCode(create)).toBe("NOT_FOUND");

    const list = await requestJson("/api/automations/webhooks", {
      method: "GET",
      headers: SESSION_HEADERS,
    });
    expect(list.status).toBe(404);

    const del = await requestStatus(
      "/api/automations/webhooks/00000000-0000-0000-0000-000000000000",
      { method: "DELETE", headers: SESSION_HEADERS },
    );
    expect(del).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await requestJson("/api/automations/webhooks", {
      method: "GET",
      headers: {},
    });
    expect(response.status).toBe(401);
    expect(expectErrorCode(response)).toBe("UNAUTHORIZED");
  });
});
