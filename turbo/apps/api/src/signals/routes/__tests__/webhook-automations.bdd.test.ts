import { createHmac } from "node:crypto";

import {
  webhookAutomationCreateResponseSchema,
  webhookAutomationListResponseSchema,
} from "@vm0/api-contracts/contracts/webhook-automations";
import {
  webhookAutomationsByIdContract,
  webhookAutomationsMainContract,
} from "@vm0/api-contracts/contracts/webhook-automations";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

// BDD migration of the legacy `webhook-automations.test.ts`.
// The 10 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// create + list + delete + foreign-thread + missing-agent
// chain (201 create persists row + chat thread + encrypted
// trigger secret + mints url token → 201 links an
// existing owned chat thread → 400 rejects a chat thread
// not owned by the caller → 404 when the target agent is
// not visible → 200 list returns the projection without
// the secret → 204 delete cascades the trigger → 404 delete
// on another scope), (2) inbound webhook end-to-end chain
// (200 accepts a signed POST at the inbound route + creates
// a webhook-sourced run on the linked thread tagged with
// the automation + trigger), (3) feature gating + auth
// chain (404 on every endpoint when the switch is off →
// 401 when unauthenticated).
//
// Service-Level Exception: The feature switch off branch
// reaches endpoints that 404 — not 401 — so we exercise
// the switch-off path before re-enabling it for the
// authenticated sub-steps.

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

const trackCreatedAutomations = createFixtureTracker<SchedulesFixture>(
  async (fixture) => {
    const db = store.set(writeDb$);
    const rows = await db
      .select({
        id: automations.id,
        chatThreadId: automations.chatThreadId,
      })
      .from(automations)
      .where(eq(automations.orgId, fixture.orgId));
    for (const row of rows) {
      await db.delete(automations).where(eq(automations.id, row.id));
      await db.delete(chatThreads).where(eq(chatThreads.id, row.chatThreadId));
    }
  },
);

function createWebhookHarness(): {
  readonly enableAutomations: (fixture: SchedulesFixture) => Promise<void>;
  readonly seedFixture: () => Promise<SchedulesFixture>;
} {
  const enableAutomations = async (fixture: SchedulesFixture) => {
    const db = store.set(writeDb$);
    await db.insert(userFeatureSwitches).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.ZeroAutomations]: true },
    });
  };
  const seedFixture = async (): Promise<SchedulesFixture> => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.s3.send.mockResolvedValue({});
    setSecretKmsClientForTests(fakeKmsClient().client);
    const fixture = await trackSchedules(
      store.set(seedSchedulesScenario$, { schedules: [] }, context.signal),
    );
    await trackCreatedAutomations(Promise.resolve(fixture));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    return fixture;
  };
  return {
    enableAutomations,
    seedFixture,
  };
}

function mainClient() {
  return setupApp({ context })(webhookAutomationsMainContract);
}

function byIdClient() {
  return setupApp({ context })(webhookAutomationsByIdContract);
}

describe("BDD webhook automations — create + list + delete + foreign-thread + missing-agent chain", () => {
  const harness = createWebhookHarness();

  it("gwt-wt-wt: 201 create persists row + chat thread + encrypted trigger secret + mints url token → 201 links an existing owned chat thread → 400 rejects a chat thread not owned by the caller → 404 when the target agent is not visible → 200 list returns the projection without the secret → 204 delete cascades the trigger → 404 delete on another scope", async () => {
    // Given: a fixture + the automations switch enabled.
    const fixture = await harness.seedFixture();
    await harness.enableAutomations(fixture);

    // When + Then: 201 — create returns a 64-hex secret,
    // a webhook URL token, + the projection is durable.
    const createResponse = await accept(
      mainClient().create({
        body: {
          name: "deploy-alerts",
          instruction: "Summarize the incoming deploy event.",
          description: "On deploy",
          agentId: fixture.composeId,
        },
        headers: SESSION_HEADERS,
      }),
      [201],
    );
    const created = webhookAutomationCreateResponseSchema.parse(
      createResponse.body,
    );
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

    // Then: the automation row is persisted with the
    // webhook interpreter + a server-created chat thread
    // is linked to the agent.
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

    // Then: the trigger row carries the token + the
    // encrypted secret (not the plaintext).
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

    // Given: a fresh fixture + an existing owned chat
    // thread.
    const linkFixture = await harness.seedFixture();
    await harness.enableAutomations(linkFixture);
    const linkDb = store.set(writeDb$);
    const [existingThread] = await linkDb
      .insert(chatThreads)
      .values({
        userId: linkFixture.userId,
        agentComposeId: linkFixture.composeId,
        title: "existing thread",
      })
      .returning({ id: chatThreads.id });

    // When + Then: 201 — links the existing owned thread.
    const linkResponse = await accept(
      mainClient().create({
        body: {
          name: "linked",
          instruction: "Handle it.",
          agentId: linkFixture.composeId,
          chatThreadId: existingThread!.id,
        },
        headers: SESSION_HEADERS,
      }),
      [201],
    );
    const linked = webhookAutomationCreateResponseSchema.parse(
      linkResponse.body,
    );
    expect(linked.automation.chatThreadId).toBe(existingThread!.id);

    // Given: a fresh fixture + a chat thread owned by
    // another user.
    const foreignFixture = await harness.seedFixture();
    await harness.enableAutomations(foreignFixture);
    const foreignDb = store.set(writeDb$);
    const [foreignThread] = await foreignDb
      .insert(chatThreads)
      .values({
        userId: "user_someone_else",
        agentComposeId: foreignFixture.composeId,
        title: "foreign thread",
      })
      .returning({ id: chatThreads.id });

    // When + Then: 400 — a chat thread not owned by the
    // caller is rejected.
    const foreignResponse = await accept(
      mainClient().create({
        body: {
          name: "bad-link",
          instruction: "Handle it.",
          agentId: foreignFixture.composeId,
          chatThreadId: foreignThread!.id,
        },
        headers: SESSION_HEADERS,
      }),
      [400],
    );
    expect(foreignResponse.body.error.code).toBe("BAD_REQUEST");
    await foreignDb
      .delete(chatThreads)
      .where(eq(chatThreads.id, foreignThread!.id));

    // Given: a fresh fixture + a non-existent agent id.

    // When + Then: 404 — the target agent is not visible.
    const noAgentFixture = await harness.seedFixture();
    await harness.enableAutomations(noAgentFixture);
    const noAgentResponse = await accept(
      mainClient().create({
        body: {
          name: "no-agent",
          instruction: "Handle it.",
          agentId: "00000000-0000-0000-0000-000000000000",
        },
        headers: SESSION_HEADERS,
      }),
      [404],
    );
    expect(noAgentResponse.body.error.code).toBe("NOT_FOUND");

    // Given: a fresh fixture + a created automation.

    // When + Then: 200 — list returns the projection
    // without the secret.
    const listFixture = await harness.seedFixture();
    await harness.enableAutomations(listFixture);
    const listCreateResponse = await accept(
      mainClient().create({
        body: {
          name: "listed",
          instruction: "Summarize.",
          agentId: listFixture.composeId,
        },
        headers: SESSION_HEADERS,
      }),
      [201],
    );
    const listCreated = webhookAutomationCreateResponseSchema.parse(
      listCreateResponse.body,
    );
    const listResponse = await accept(
      mainClient().list({ headers: SESSION_HEADERS }),
      [200],
    );
    const list = webhookAutomationListResponseSchema.parse(listResponse.body);
    expect(list.automations).toHaveLength(1);
    const [item] = list.automations;
    expect(item?.id).toBe(listCreated.automation.id);
    expect(item?.webhookToken).toBe(listCreated.automation.webhookToken);
    expect(item?.webhookUrl).toBe(listCreated.automation.webhookUrl);
    expect(Object.keys(item ?? {})).not.toContain("secret");

    // Given: a fresh fixture + a created automation to
    // delete.

    // When + Then: 204 — delete cascades the trigger.
    const delFixture = await harness.seedFixture();
    await harness.enableAutomations(delFixture);
    const delCreateResponse = await accept(
      mainClient().create({
        body: {
          name: "removable",
          instruction: "Summarize.",
          agentId: delFixture.composeId,
        },
        headers: SESSION_HEADERS,
      }),
      [201],
    );
    const delCreated = webhookAutomationCreateResponseSchema.parse(
      delCreateResponse.body,
    );
    const delStatus = await accept(
      byIdClient().delete({
        params: { id: delCreated.automation.id },
        headers: SESSION_HEADERS,
      }),
      [204],
    );
    expect(delStatus.body).toBeUndefined();
    const delDb = store.set(writeDb$);
    const automationRows = await delDb
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.id, delCreated.automation.id));
    expect(automationRows).toHaveLength(0);
    const triggerRows = await delDb
      .select({ id: automationTriggers.id })
      .from(automationTriggers)
      .where(eq(automationTriggers.automationId, delCreated.automation.id));
    expect(triggerRows).toHaveLength(0);

    // Given: a fresh fixture + a non-existent id.

    // When + Then: 404 — deleting an automation owned by
    // another scope.
    const otherScopeFixture = await harness.seedFixture();
    await harness.enableAutomations(otherScopeFixture);
    const otherScopeResponse = await accept(
      byIdClient().delete({
        params: { id: "00000000-0000-0000-0000-000000000000" },
        headers: SESSION_HEADERS,
      }),
      [404],
    );
    expect(otherScopeResponse.body.error.code).toBe("NOT_FOUND");
  });
});

describe("BDD webhook automations — inbound webhook end-to-end chain", () => {
  const harness = createWebhookHarness();

  it("gwt-wt-wt: 200 accepts a signed POST at the inbound route + creates a webhook-sourced run on the linked thread tagged with the automation + trigger", async () => {
    // Given: a fixture + the automations switch enabled +
    // a created webhook automation.
    const fixture = await harness.seedFixture();
    await harness.enableAutomations(fixture);
    const createResponse = await accept(
      mainClient().create({
        body: {
          name: "end-to-end",
          instruction: "Summarize the incoming webhook event.",
          agentId: fixture.composeId,
        },
        headers: SESSION_HEADERS,
      }),
      [201],
    );
    const created = webhookAutomationCreateResponseSchema.parse(
      createResponse.body,
    );

    // When: a signed POST is made to the inbound route.
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

    // Then: 200 — the inbound dispatch created a
    // webhook-sourced run on the linked thread.
    expect(inbound.status).toBe(200);

    // Then: the run row is tagged with the automation +
    // trigger that fired it.
    const db = store.set(writeDb$);
    const [trigger] = await db
      .select({ id: automationTriggers.id })
      .from(automationTriggers)
      .where(
        eq(automationTriggers.webhookToken, created.automation.webhookToken),
      );
    const [run] = await db
      .select({
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
        automationId: zeroRuns.automationId,
        triggerId: zeroRuns.triggerId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.chatThreadId, created.automation.chatThreadId));
    expect(run).toStrictEqual({
      triggerSource: "webhook",
      chatThreadId: created.automation.chatThreadId,
      automationId: created.automation.id,
      triggerId: trigger?.id,
    });
  });
});

describe("BDD webhook automations — feature gating + auth chain", () => {
  const harness = createWebhookHarness();

  it("gwt-wt-wt: 404 on every endpoint when the switch is off → 401 when unauthenticated", async () => {
    // Given: a fixture WITHOUT the automations switch.

    // When + Then: 404 on create + 404 on list + 404 on
    // delete.
    const gatedFixture = await harness.seedFixture();
    const gatedCreate = await accept(
      mainClient().create({
        body: {
          name: "blocked",
          instruction: "Should not be created.",
          agentId: gatedFixture.composeId,
        },
        headers: SESSION_HEADERS,
      }),
      [404],
    );
    expect(gatedCreate.body.error.code).toBe("NOT_FOUND");
    const gatedList = await accept(
      mainClient().list({ headers: SESSION_HEADERS }),
      [404],
    );
    expect(gatedList.body.error.code).toBe("NOT_FOUND");
    const gatedDelete = await accept(
      byIdClient().delete({
        params: { id: "00000000-0000-0000-0000-000000000000" },
        headers: SESSION_HEADERS,
      }),
      [404],
    );
    expect(gatedDelete.body.error.code).toBe("NOT_FOUND");

    // Given: no auth header.

    // When + Then: 401 — unauthenticated list.
    const unauthResponse = await accept(
      mainClient().list({ headers: {} }),
      [401],
    );
    expect(unauthResponse.body.error.code).toBe("UNAUTHORIZED");
  });
});
