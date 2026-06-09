import { createHmac, randomUUID } from "node:crypto";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { afterEach } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
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
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const SIGNATURE_HEADER = "x-vm0-signature-256";
const WEBHOOK_SECRET = "automation-webhook-secret";

afterEach(() => {
  resetSecretKmsClientForTests();
});

interface AutomationFixture {
  readonly schedules: SchedulesFixture;
  readonly automationId: string;
  readonly triggerId: string;
  readonly threadId: string;
  readonly token: string;
}

const trackSchedules = createFixtureTracker<SchedulesFixture>((fixture) => {
  return store.set(deleteSchedulesScenario$, fixture, context.signal);
});

const trackAutomation = createFixtureTracker<AutomationFixture>(
  async (fixture) => {
    const db = store.set(writeDb$);
    await db
      .delete(automationTriggers)
      .where(eq(automationTriggers.id, fixture.triggerId));
    await db
      .delete(automations)
      .where(eq(automations.id, fixture.automationId));
    await db.delete(chatThreads).where(eq(chatThreads.id, fixture.threadId));
  },
);

function sign(body: string, secret: string = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function seedAutomation(args?: {
  readonly enabled?: boolean;
}): Promise<AutomationFixture> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.s3.send.mockResolvedValue({});
  setSecretKmsClientForTests(fakeKmsClient().client);

  const schedules = await trackSchedules(
    store.set(
      seedSchedulesScenario$,
      {
        userName: "Automation Owner",
        userEmail: "automation-owner@example.com",
        schedules: [],
      },
      context.signal,
    ),
  );
  mocks.clerk.session(schedules.userId, schedules.orgId);

  const db = store.set(writeDb$);
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: schedules.userId,
      agentComposeId: schedules.composeId,
      title: "automation thread",
    })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error("seedAutomation: chat thread insert returned no row");
  }

  const [automation] = await db
    .insert(automations)
    .values({
      orgId: schedules.orgId,
      userId: schedules.userId,
      name: "inbound-webhook",
      instruction: "Summarize the incoming webhook event.",
      agentId: schedules.composeId,
      chatThreadId: thread.id,
      interpreterKind: "webhook",
      enabled: args?.enabled ?? true,
    })
    .returning({ id: automations.id });
  if (!automation) {
    throw new Error("seedAutomation: automation insert returned no row");
  }

  const token = `whk_${randomUUID().replace(/-/g, "")}`;
  const [trigger] = await db
    .insert(automationTriggers)
    .values({
      automationId: automation.id,
      kind: "webhook",
      webhookToken: token,
      encryptedSecret: encryptSecretForTests(WEBHOOK_SECRET),
    })
    .returning({ id: automationTriggers.id });
  if (!trigger) {
    throw new Error("seedAutomation: trigger insert returned no row");
  }

  return await trackAutomation(
    Promise.resolve({
      schedules,
      automationId: automation.id,
      triggerId: trigger.id,
      threadId: thread.id,
      token,
    }),
  );
}

async function postWebhook(
  token: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly text: string }> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(`/api/automations/webhooks/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return { status: response.status, text: await response.text() };
}

describe("POST /api/automations/webhooks/:token", () => {
  it("fires a signed webhook into a webhook-sourced run + chat message", async () => {
    const fixture = await seedAutomation();
    const body = JSON.stringify({ event: "ping", value: 42 });

    const response = await postWebhook(fixture.token, body, {
      [SIGNATURE_HEADER]: sign(body),
      "x-custom-header": "header-value",
    });

    expect(response.status).toBe(200);

    const db = store.set(writeDb$);
    const [zeroRun] = await db
      .select({
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.chatThreadId, fixture.threadId));
    expect(zeroRun).toStrictEqual({
      triggerSource: "webhook",
      chatThreadId: fixture.threadId,
    });

    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .where(eq(zeroRuns.chatThreadId, fixture.threadId));
    expect(run?.prompt).toBe("Summarize the incoming webhook event.");
    // The webhook payload (headers + body) is rendered into the run context.
    expect(run?.appendSystemPrompt).toContain(
      "You are currently running inside: Webhook automation",
    );
    expect(run?.appendSystemPrompt).toContain('"event": "ping"');
    expect(run?.appendSystemPrompt).toContain('"x-custom-header"');

    // The instruction was posted as a user message bound to the run.
    const messages = await db
      .select({
        content: chatMessages.content,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatThreadId, fixture.threadId));
    expect(
      messages.some((message) => {
        return (
          message.role === "user" &&
          message.content === "Summarize the incoming webhook event."
        );
      }),
    ).toBeTruthy();
  });

  it("rejects a payload with a bad signature", async () => {
    const fixture = await seedAutomation();
    const body = JSON.stringify({ event: "ping" });

    const response = await postWebhook(fixture.token, body, {
      [SIGNATURE_HEADER]: sign(body, "wrong-secret"),
    });

    expect(response.status).toBe(401);

    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(eq(zeroRuns.chatThreadId, fixture.threadId));
    expect(runs).toHaveLength(0);
  });

  it("rejects a payload with no signature header", async () => {
    const fixture = await seedAutomation();
    const body = JSON.stringify({ event: "ping" });

    const response = await postWebhook(fixture.token, body, {});

    expect(response.status).toBe(401);
  });

  it("returns 404 for an unknown token", async () => {
    await seedAutomation();
    const body = JSON.stringify({ event: "ping" });

    const response = await postWebhook(
      `whk_${randomUUID().replace(/-/g, "")}`,
      body,
      { [SIGNATURE_HEADER]: sign(body) },
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 for a disabled automation", async () => {
    const fixture = await seedAutomation({ enabled: false });
    const body = JSON.stringify({ event: "ping" });

    const response = await postWebhook(fixture.token, body, {
      [SIGNATURE_HEADER]: sign(body),
    });

    expect(response.status).toBe(404);
  });
});
