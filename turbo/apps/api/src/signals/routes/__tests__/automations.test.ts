import { randomUUID } from "node:crypto";

import {
  automationsByRefContract,
  automationsMainContract,
  automationTriggersContract,
} from "@vm0/api-contracts/contracts/automations";
import { cronExecuteAutomationsContract } from "@vm0/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { asc, eq, inArray } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { writeDb$ } from "../../external/db";
import {
  type AutomationsFixture,
  deleteAutomationsScenario$,
  seedAutomationsScenario$,
} from "./helpers/automations";
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
const CRON_SECRET = "test-cron-secret";

afterEach(() => {
  resetSecretKmsClientForTests();
});

function mainApi() {
  return setupApp({ context })(automationsMainContract);
}

function refApi() {
  return setupApp({ context })(automationsByRefContract);
}

function triggerApi() {
  return setupApp({ context })(automationTriggersContract);
}

function cronApi() {
  return setupApp({ context })(cronExecuteAutomationsContract);
}

const trackAutomations = createFixtureTracker<AutomationsFixture>((fixture) => {
  return store.set(deleteAutomationsScenario$, fixture, context.signal);
});

// Automations created through the API are not part of the schedule fixture, so
// delete them by their org scope after each test. The trigger rows cascade
// with the automation; the linked chat threads are removed explicitly.
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

// Extra agent composes seeded for the ambiguous-name scenario. Registered
// after the automation tracker so this cleanup runs FIRST (vitest unwinds
// afterEach hooks in reverse): the compose cascade removes its automations and
// chat threads before the broader org sweep runs.
const trackExtraComposes = createFixtureTracker<string>(async (composeId) => {
  const db = store.set(writeDb$);
  await db.delete(agentComposes).where(eq(agentComposes.id, composeId));
});

async function seedFixture(): Promise<AutomationsFixture> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  // Pin the description generator to its deterministic template fallback: an
  // ambient key would make description-less creates call openrouter.ai live.
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  context.mocks.s3.send.mockResolvedValue({});
  setSecretKmsClientForTests(fakeKmsClient().client);
  const fixture = await trackAutomations(
    store.set(seedAutomationsScenario$, { automations: [] }, context.signal),
  );
  await trackCreatedAutomations(Promise.resolve(fixture));
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function enableWebhookTriggers(
  fixture: AutomationsFixture,
  options?: { readonly webhookTriggers?: boolean },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: {
      [FeatureSwitchKey.AutomationWebhookTriggers]:
        options?.webhookTriggers ?? true,
    },
  });
}

interface CreateArgs {
  readonly name: string;
  readonly agentId: string;
  readonly instruction?: string;
  readonly description?: string;
  readonly appendSystemPrompt?: string;
  readonly enabled?: boolean;
  readonly trigger?:
    | { readonly kind: "cron"; readonly cronExpression: string }
    | { readonly kind: "once"; readonly atTime: string }
    | { readonly kind: "loop"; readonly intervalSeconds: number }
    | { readonly kind: "webhook" };
}

async function createAutomation(args: CreateArgs) {
  const response = await accept(
    mainApi().create({
      headers: SESSION_HEADERS,
      body: {
        name: args.name,
        agentId: args.agentId,
        instruction: args.instruction ?? "Do the automated thing.",
        ...(args.description !== undefined
          ? { description: args.description }
          : {}),
        ...(args.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: args.appendSystemPrompt }
          : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
      },
    }),
    [201],
  );
  return response.body;
}

async function findTriggerRows(automationId: string) {
  const db = store.set(writeDb$);
  return await db
    .select()
    .from(automationTriggers)
    .where(eq(automationTriggers.automationId, automationId))
    .orderBy(asc(automationTriggers.createdAt), asc(automationTriggers.id));
}

describe("Automations API", () => {
  it("creates a triggerless automation with a server-created chat thread", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "daily-digest",
      agentId: fixture.composeId,
      instruction: "Summarize the day.",
      description: "Daily digest",
    });

    expect(created.webhookSecret).toBeUndefined();
    const { automation } = created;
    expect(automation.name).toBe("daily-digest");
    expect(automation.displayName).toBe("Test Agent");
    expect(automation.userId).toBe(fixture.userId);
    expect(automation.instruction).toBe("Summarize the day.");
    expect(automation.description).toBe("Daily digest");
    expect(automation.enabled).toBeTruthy();
    expect(automation.triggers).toStrictEqual([]);

    const db = store.set(writeDb$);
    const [row] = await db
      .select({
        interpreterKind: automations.interpreterKind,
        orgId: automations.orgId,
      })
      .from(automations)
      .where(eq(automations.id, automation.id));
    // D1: natively-created automations persist the default interpreter.
    expect(row).toStrictEqual({
      interpreterKind: "default",
      orgId: fixture.orgId,
    });

    const [thread] = await db
      .select({
        title: chatThreads.title,
        userId: chatThreads.userId,
        agentComposeId: chatThreads.agentComposeId,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, automation.chatThreadId));
    expect(thread).toStrictEqual({
      title: "Daily digest",
      userId: fixture.userId,
      agentComposeId: fixture.composeId,
    });
  });

  it("creates an automation with a first cron trigger via sugar", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "cron-sugar",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    expect(created.webhookSecret).toBeUndefined();
    const [trigger] = created.automation.triggers;
    if (trigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(trigger.cronExpression).toBe("0 9 * * *");
    expect(trigger.timezone).toBe("UTC");
    expect(trigger.enabled).toBeTruthy();
    expect(trigger.nextRunAt).not.toBeNull();
    expect(Date.parse(trigger.nextRunAt!)).toBeGreaterThan(now());
    // An omitted description is generated server-side (template fallback when
    // no model key is configured) — parity with the legacy schedule deploy.
    expect(created.automation.description).toMatch(/recurring task:/u);

    // A cron trigger on a disabled automation stays unscheduled until enable.
    const disabled = await createAutomation({
      name: "cron-sugar-disabled",
      agentId: fixture.composeId,
      enabled: false,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const [disabledTrigger] = disabled.automation.triggers;
    if (disabledTrigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(disabledTrigger.nextRunAt).toBeNull();
  });

  it("creates an automation with a webhook trigger and returns the secret once", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "on-deploy",
      agentId: fixture.composeId,
      trigger: { kind: "webhook" },
    });
    expect(created.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    const [trigger] = created.automation.triggers;
    if (trigger?.kind !== "webhook") {
      throw new Error("Expected a webhook trigger");
    }
    expect(trigger.webhookToken).toMatch(/^whk_[0-9a-f]{48}$/);
    expect(trigger.webhookUrl).toBe(
      `http://localhost:3000/api/automations/webhooks/${trigger.webhookToken}`,
    );

    // The stored secret is encrypted at rest and decrypts to the one-shot value.
    const [row] = await findTriggerRows(created.automation.id);
    expect(row?.encryptedSecret).not.toBeNull();
    expect(row?.encryptedSecret).not.toContain(created.webhookSecret!);
    expect(decryptSecretForTests(row!.encryptedSecret!)).toBe(
      created.webhookSecret,
    );

    // The secret is never projected again: show/list surface only the token.
    const shown = await accept(
      refApi().show({
        params: { ref: created.automation.id },
        headers: SESSION_HEADERS,
      }),
      [200],
    );
    expect(Object.keys(shown.body)).not.toContain("webhookSecret");
  });

  it("rejects webhook trigger creation and rotation while the switch is off", async () => {
    // Webhook triggers are a feature-gated NEW capability (#17307): with the
    // switch off the surface stays feature-equivalent to legacy schedules.
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture, { webhookTriggers: false });

    const viaSugar = await accept(
      mainApi().create({
        body: {
          name: "gated-webhook",
          agentId: fixture.composeId,
          instruction: "Handle the hook",
          trigger: { kind: "webhook" },
        },
        headers: SESSION_HEADERS,
      }),
      [400],
    );
    expect(viaSugar.body.error.message).toContain("not enabled");

    const created = await createAutomation({
      name: "gated-add",
      agentId: fixture.composeId,
    });
    const viaAdd = await accept(
      refApi().addTrigger({
        params: { ref: created.automation.id },
        body: { kind: "webhook" },
        headers: SESSION_HEADERS,
      }),
      [400],
    );
    expect(viaAdd.body.error.message).toContain("not enabled");

    // Rotation is gated before trigger resolution, so any id is rejected.
    const viaRotate = await accept(
      triggerApi().rotateSecret({
        params: { id: "00000000-0000-0000-0000-000000000000" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [400],
    );
    expect(viaRotate.body.error.message).toContain("not enabled");

    // Time triggers stay fully available.
    const cron = await accept(
      refApi().addTrigger({
        params: { ref: created.automation.id },
        body: { kind: "cron", cronExpression: "0 9 * * *" },
        headers: SESSION_HEADERS,
      }),
      [201],
    );
    expect(cron.body.trigger.kind).toBe("cron");
  });

  it("rejects an invalid cron expression, a past atTime, and a bad timezone", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const badCron = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "bad-cron",
          agentId: fixture.composeId,
          instruction: "Never.",
          trigger: { kind: "cron", cronExpression: "not a cron" },
        },
      }),
      [400],
    );
    expect(badCron.body.error.code).toBe("BAD_REQUEST");

    const created = await createAutomation({
      name: "validation-target",
      agentId: fixture.composeId,
    });
    const pastAtTime = await accept(
      refApi().addTrigger({
        params: { ref: created.automation.id },
        headers: SESSION_HEADERS,
        body: {
          kind: "once",
          atTime: new Date(now() - 60_000).toISOString(),
        },
      }),
      [400],
    );
    expect(pastAtTime.body.error.message).toContain("already passed");

    const badTimezone = await accept(
      refApi().addTrigger({
        params: { ref: created.automation.id },
        headers: SESSION_HEADERS,
        body: {
          kind: "cron",
          cronExpression: "0 9 * * *",
          timezone: "Mars/Olympus",
        },
      }),
      [400],
    );
    expect(badTimezone.body.error.message).toContain("Invalid timezone");
  });

  it("rejects a duplicate name on the same agent", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    await createAutomation({ name: "dup", agentId: fixture.composeId });
    const conflictResponse = await accept(
      mainApi().create({
        headers: SESSION_HEADERS,
        body: {
          name: "dup",
          agentId: fixture.composeId,
          instruction: "Again.",
        },
      }),
      [400],
    );
    expect(conflictResponse.body.error.message).toContain("already exists");
  });

  it("rejects an ambiguous name ref and still resolves by id", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const extraComposeId = await trackExtraComposes(
      Promise.resolve(randomUUID()),
    );
    const db = store.set(writeDb$);
    await db.insert(agentComposes).values({
      id: extraComposeId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      name: `agent-extra-${extraComposeId.slice(0, 8)}`,
    });

    const first = await createAutomation({
      name: "shared-name",
      agentId: fixture.composeId,
    });
    await createAutomation({ name: "shared-name", agentId: extraComposeId });

    const ambiguous = await accept(
      refApi().show({
        params: { ref: "shared-name" },
        headers: SESSION_HEADERS,
      }),
      [400],
    );
    expect(ambiguous.body.error.message).toContain("Ambiguous");

    const byId = await accept(
      refApi().show({
        params: { ref: first.automation.id },
        headers: SESSION_HEADERS,
      }),
      [200],
    );
    expect(byId.body.id).toBe(first.automation.id);
  });

  it("shows and lists automations with all their triggers", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "multi-trigger",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const added = await accept(
      refApi().addTrigger({
        params: { ref: "multi-trigger" },
        headers: SESSION_HEADERS,
        body: { kind: "webhook" },
      }),
      [201],
    );
    expect(added.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(added.body.trigger.kind).toBe("webhook");

    const shown = await accept(
      refApi().show({
        params: { ref: "multi-trigger" },
        headers: SESSION_HEADERS,
      }),
      [200],
    );
    expect(shown.body.triggers).toHaveLength(2);
    expect(
      shown.body.triggers.map((trigger) => {
        return trigger.kind;
      }),
    ).toStrictEqual(expect.arrayContaining(["cron", "webhook"]));

    const listed = await accept(
      mainApi().list({ headers: SESSION_HEADERS }),
      [200],
    );
    expect(listed.body.automations).toHaveLength(1);
    expect(listed.body.automations[0]?.id).toBe(created.automation.id);
    expect(listed.body.automations[0]?.triggers).toHaveLength(2);

    const triggerList = await accept(
      refApi().listTriggers({
        params: { ref: "multi-trigger" },
        headers: SESSION_HEADERS,
      }),
      [200],
    );
    expect(triggerList.body.triggers).toHaveLength(2);
  });

  it("updates identity fields and rejects a rename onto a taken name", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    await createAutomation({
      name: "alpha",
      agentId: fixture.composeId,
      description: "before",
    });
    await createAutomation({ name: "beta", agentId: fixture.composeId });

    const updated = await accept(
      refApi().update({
        params: { ref: "alpha" },
        headers: SESSION_HEADERS,
        body: { instruction: "Updated instruction.", description: null },
      }),
      [200],
    );
    expect(updated.body.instruction).toBe("Updated instruction.");
    expect(updated.body.description).toBeNull();
    expect(updated.body.name).toBe("alpha");

    const renameConflict = await accept(
      refApi().update({
        params: { ref: "alpha" },
        headers: SESSION_HEADERS,
        body: { name: "beta" },
      }),
      [400],
    );
    expect(renameConflict.body.error.message).toContain("already exists");

    const renamed = await accept(
      refApi().update({
        params: { ref: "alpha" },
        headers: SESSION_HEADERS,
        body: { name: "gamma" },
      }),
      [200],
    );
    expect(renamed.body.name).toBe("gamma");
  });

  it("disable clears time-trigger next runs and enable recomputes them", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);
    mockEnv("CRON_SECRET", CRON_SECRET);

    const created = await createAutomation({
      name: "suspend-me",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const automationId = created.automation.id;
    const dueTime = new Date(now() - 60_000);
    const db = store.set(writeDb$);
    await db
      .update(automationTriggers)
      .set({ nextRunAt: dueTime })
      .where(eq(automationTriggers.automationId, automationId));

    const disabled = await accept(
      refApi().disable({
        params: { ref: "suspend-me" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    // Disable clears next_run_at on the time trigger so the poller stops seeing
    // it (#17546), but leaves the trigger's own enabled flag intact.
    const [suspended] = await findTriggerRows(automationId);
    expect(suspended?.enabled).toBeTruthy();
    expect(suspended?.nextRunAt).toBeNull();

    // The poller's SQL filter no longer surfaces the disabled automation's
    // trigger at all, so it is neither claimed nor counted as skipped.
    const cronResponse = await accept(
      cronApi().execute({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(cronResponse.body.executed).toBe(0);
    const runs = await db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(eq(zeroRuns.automationId, automationId));
    expect(runs).toHaveLength(0);

    // An expired one-time trigger is disabled on enable instead of firing.
    const onceAdded = await accept(
      refApi().addTrigger({
        params: { ref: "suspend-me" },
        headers: SESSION_HEADERS,
        body: {
          kind: "once",
          atTime: new Date(now() + 3_600_000).toISOString(),
        },
      }),
      [201],
    );
    await db
      .update(automationTriggers)
      .set({ atTime: dueTime, nextRunAt: dueTime })
      .where(eq(automationTriggers.id, onceAdded.body.trigger.id));

    const enabled = await accept(
      refApi().enable({
        params: { ref: "suspend-me" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    const cronTrigger = enabled.body.triggers.find((trigger) => {
      return trigger.kind === "cron";
    });
    if (cronTrigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    // No catch-up: the stale due time is replaced by the next occurrence.
    expect(Date.parse(cronTrigger.nextRunAt!)).toBeGreaterThan(now());
    const onceTrigger = enabled.body.triggers.find((trigger) => {
      return trigger.id === onceAdded.body.trigger.id;
    });
    if (onceTrigger?.kind !== "once") {
      throw new Error("Expected a once trigger");
    }
    expect(onceTrigger.enabled).toBeFalsy();
    expect(onceTrigger.nextRunAt).toBeNull();
  });

  it("creating a loop trigger on a disabled automation leaves next run unscheduled", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const disabled = await createAutomation({
      name: "loop-disabled",
      agentId: fixture.composeId,
      enabled: false,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const [loopTrigger] = disabled.automation.triggers;
    if (loopTrigger?.kind !== "loop") {
      throw new Error("Expected a loop trigger");
    }
    // A loop trigger is always due by design; gating its next run on the
    // automation flag stops a disabled automation from minting a permanently-due
    // "zombie" row (#17546).
    expect(loopTrigger.nextRunAt).toBeNull();
  });

  it("disable clears cron and loop next runs but keeps enabled and last run; re-enable recomputes", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "round-trip",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const automationId = created.automation.id;
    await accept(
      refApi().addTrigger({
        params: { ref: "round-trip" },
        headers: SESSION_HEADERS,
        body: { kind: "loop", intervalSeconds: 300 },
      }),
      [201],
    );

    // Stamp a last run on both triggers to prove disable does not clear it.
    const db = store.set(writeDb$);
    const [session] = await db
      .insert(agentSessions)
      .values({
        userId: fixture.userId,
        orgId: fixture.orgId,
        agentComposeId: fixture.composeId,
      })
      .returning({ id: agentSessions.id });
    const [priorRun] = await db
      .insert(agentRuns)
      .values({
        userId: fixture.userId,
        orgId: fixture.orgId,
        sessionId: session!.id,
        status: "completed",
        prompt: "prior run",
      })
      .returning({ id: agentRuns.id });
    const fakeRunId = priorRun!.id;
    await db
      .update(automationTriggers)
      .set({ lastRunId: fakeRunId })
      .where(eq(automationTriggers.automationId, automationId));

    const disabled = await accept(
      refApi().disable({
        params: { ref: "round-trip" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    const suspendedRows = await findTriggerRows(automationId);
    for (const row of suspendedRows) {
      // Both time triggers lose their next run but keep their own enabled flag
      // and last-run history.
      expect(row.nextRunAt).toBeNull();
      expect(row.enabled).toBeTruthy();
      expect(row.lastRunId).toBe(fakeRunId);
    }

    const enabled = await accept(
      refApi().enable({
        params: { ref: "round-trip" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    // Re-enable recomputes the next run for both kinds (cron → next occurrence,
    // loop → due now).
    const cronTrigger = enabled.body.triggers.find((trigger) => {
      return trigger.kind === "cron";
    });
    if (cronTrigger?.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(Date.parse(cronTrigger.nextRunAt!)).toBeGreaterThan(now());
    const loopTrigger = enabled.body.triggers.find((trigger) => {
      return trigger.kind === "loop";
    });
    if (loopTrigger?.kind !== "loop") {
      throw new Error("Expected a loop trigger");
    }
    expect(loopTrigger.nextRunAt).not.toBeNull();

    // The last-run history (an internal column) survives the round trip.
    const enabledRows = await findTriggerRows(automationId);
    for (const row of enabledRows) {
      expect(row.lastRunId).toBe(fakeRunId);
    }
  });

  it("the poller does not let disabled-automation zombies starve a due trigger", async () => {
    // #17546 regression: historically, disabling an automation left its loop
    // trigger enabled with a past next_run_at (a permanently-due "zombie"). With
    // >10 such rows, the old unordered LIMIT 10 batch filled with zombies every
    // tick and a genuinely-due trigger never got claimed. The SQL automation
    // filter plus the raised batch cap fix it.
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    context.mocks.s3.send.mockResolvedValue({});
    setSecretKmsClientForTests(fakeKmsClient().client);
    mockEnv("CRON_SECRET", CRON_SECRET);

    const pastDue = new Date(now() - 60_000);
    const fixture = await trackAutomations(
      store.set(
        seedAutomationsScenario$,
        {
          automations: [
            // 12 zombies: enabled loop triggers, automation flag flipped off
            // below. >10 proves the old LIMIT 10 starvation.
            ...Array.from({ length: 12 }, (_, index) => {
              return {
                name: `zombie-${index}`,
                prompt: "Zombie task",
                triggerType: "loop" as const,
                intervalSeconds: 300,
                enabled: true,
                nextRunAt: pastDue,
              };
            }),
            // The one healthy, enabled automation with a due loop trigger.
            {
              name: "healthy",
              prompt: "Healthy task",
              triggerType: "loop" as const,
              intervalSeconds: 300,
              enabled: true,
              nextRunAt: pastDue,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const db = store.set(writeDb$);
    // Flip the first 12 automations off WITHOUT touching their trigger rows:
    // exactly the historical zombie shape (trigger enabled=true,
    // next_run_at in the past, automation enabled=false).
    const zombieIds = fixture.automationIds.slice(0, 12);
    const healthyId = fixture.automationIds[12]!;
    await db
      .update(automations)
      .set({ enabled: false })
      .where(inArray(automations.id, [...zombieIds]));

    const response = await accept(
      cronApi().execute({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    // The healthy trigger was claimed and run despite 12 starving zombies.
    expect(response.body.executed).toBe(1);

    const [healthyTrigger] = await findTriggerRows(healthyId);
    expect(healthyTrigger?.nextRunAt).toBeNull();
    expect(healthyTrigger?.lastRunId).not.toBeNull();
    const healthyRuns = await db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(eq(zeroRuns.automationId, healthyId));
    expect(healthyRuns).toHaveLength(1);

    // The zombies were never touched: still due, never run.
    const zombieTriggers = await db
      .select({
        nextRunAt: automationTriggers.nextRunAt,
        lastRunId: automationTriggers.lastRunId,
      })
      .from(automationTriggers)
      .innerJoin(
        automations,
        eq(automationTriggers.automationId, automations.id),
      )
      .where(inArray(automations.id, [...zombieIds]));
    expect(zombieTriggers).toHaveLength(12);
    for (const zombie of zombieTriggers) {
      expect(zombie.nextRunAt).toStrictEqual(pastDue);
      expect(zombie.lastRunId).toBeNull();
    }
    const zombieRuns = await db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .where(inArray(zeroRuns.automationId, [...zombieIds]));
    expect(zombieRuns).toHaveLength(0);
  });

  it("enables and disables a single trigger", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "per-trigger",
      agentId: fixture.composeId,
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });
    const cronTriggerId = created.automation.triggers[0]!.id;

    const disabledTrigger = await accept(
      triggerApi().disable({
        params: { id: cronTriggerId },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(disabledTrigger.body.enabled).toBeFalsy();
    if (disabledTrigger.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    // Disabling leaves the time state as-is; the poller skips via the flag.
    expect(disabledTrigger.body.nextRunAt).not.toBeNull();

    const enabledTrigger = await accept(
      triggerApi().enable({
        params: { id: cronTriggerId },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(enabledTrigger.body.enabled).toBeTruthy();
    if (enabledTrigger.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(Date.parse(enabledTrigger.body.nextRunAt!)).toBeGreaterThan(now());

    // A webhook trigger toggles its inbound gate flag.
    const webhookAdded = await accept(
      refApi().addTrigger({
        params: { ref: "per-trigger" },
        headers: SESSION_HEADERS,
        body: { kind: "webhook" },
      }),
      [201],
    );
    const webhookDisabled = await accept(
      triggerApi().disable({
        params: { id: webhookAdded.body.trigger.id },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(webhookDisabled.body.enabled).toBeFalsy();

    // Re-enabling an expired one-time trigger is rejected.
    const onceAdded = await accept(
      refApi().addTrigger({
        params: { ref: "per-trigger" },
        headers: SESSION_HEADERS,
        body: {
          kind: "once",
          atTime: new Date(now() + 3_600_000).toISOString(),
        },
      }),
      [201],
    );
    const db = store.set(writeDb$);
    await db
      .update(automationTriggers)
      .set({
        atTime: new Date(now() - 60_000),
        nextRunAt: null,
        enabled: false,
      })
      .where(eq(automationTriggers.id, onceAdded.body.trigger.id));
    const expired = await accept(
      triggerApi().enable({
        params: { id: onceAdded.body.trigger.id },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [400],
    );
    expect(expired.body.error.message).toContain("already passed");
  });

  it("updates a trigger's schedule in place, preserving id and run history", async () => {
    const fixture = await seedFixture();

    const created = await createAutomation({
      name: "retime-me",
      agentId: fixture.composeId,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const triggerId = created.automation.triggers[0]!.id;

    // A manual fire stamps lastRunId; a seeded failure count exercises the
    // revive semantics (the counter resets on update, like enable).
    const runResponse = await accept(
      refApi().run({
        params: { ref: "retime-me" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [201],
    );
    const db = store.set(writeDb$);
    await db
      .update(automationTriggers)
      .set({ consecutiveFailures: 2 })
      .where(eq(automationTriggers.id, triggerId));

    const updated = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: { kind: "loop", intervalSeconds: 600 },
      }),
      [200],
    );
    if (updated.body.kind !== "loop") {
      throw new Error("Expected a loop trigger");
    }
    expect(updated.body.id).toBe(triggerId);
    expect(updated.body.intervalSeconds).toBe(600);
    expect(updated.body.consecutiveFailures).toBe(0);
    expect(updated.body.nextRunAt).not.toBeNull();

    const [row] = await findTriggerRows(created.automation.id);
    expect(row?.lastRunId).toBe(runResponse.body.runId);

    // The kind may switch: loop → cron swaps the config columns in place.
    const switched = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: {
          kind: "cron",
          cronExpression: "0 9 * * *",
          timezone: "Asia/Shanghai",
        },
      }),
      [200],
    );
    if (switched.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(switched.body.id).toBe(triggerId);
    expect(switched.body.cronExpression).toBe("0 9 * * *");
    expect(switched.body.timezone).toBe("Asia/Shanghai");
    expect(Date.parse(switched.body.nextRunAt!)).toBeGreaterThan(now());

    const [switchedRow] = await findTriggerRows(created.automation.id);
    expect(switchedRow?.kind).toBe("cron");
    expect(switchedRow?.intervalSeconds).toBeNull();
    expect(switchedRow?.atTime).toBeNull();
    expect(switchedRow?.lastRunId).toBe(runResponse.body.runId);
    expect(switchedRow?.enabled).toBeTruthy();
  });

  it("rejects invalid schedule updates and webhook trigger updates", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "update-validate",
      agentId: fixture.composeId,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const triggerId = created.automation.triggers[0]!.id;

    const pastOnce = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: { kind: "once", atTime: new Date(now() - 60_000).toISOString() },
      }),
      [400],
    );
    expect(pastOnce.body.error.message).toContain("already passed");

    const badCron = await accept(
      triggerApi().update({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: { kind: "cron", cronExpression: "not a cron" },
      }),
      [400],
    );
    expect(badCron.body.error.message).toContain("Invalid cron expression");

    // A failed validation leaves the row untouched.
    const [row] = await findTriggerRows(created.automation.id);
    expect(row?.kind).toBe("loop");
    expect(row?.intervalSeconds).toBe(300);

    // Webhook triggers carry no schedule.
    const webhookAdded = await accept(
      refApi().addTrigger({
        params: { ref: "update-validate" },
        headers: SESSION_HEADERS,
        body: { kind: "webhook" },
      }),
      [201],
    );
    const webhookRejected = await accept(
      triggerApi().update({
        params: { id: webhookAdded.body.trigger.id },
        headers: SESSION_HEADERS,
        body: { kind: "loop", intervalSeconds: 60 },
      }),
      [400],
    );
    expect(webhookRejected.body.error.message).toContain(
      "no schedule to update",
    );
  });

  it("scopes trigger updates to the caller and gates cron next runs on the automation flag", async () => {
    const fixture = await seedFixture();

    // Another user's trigger resolves as not found.
    const otherFixture = await trackAutomations(
      store.set(
        seedAutomationsScenario$,
        {
          automations: [
            { name: "other-loop", prompt: "Other task", intervalSeconds: 300 },
          ],
        },
        context.signal,
      ),
    );
    const [otherTrigger] = await findTriggerRows(
      otherFixture.automationIds[0]!,
    );
    const denied = await accept(
      triggerApi().update({
        params: { id: otherTrigger!.id },
        headers: SESSION_HEADERS,
        body: { kind: "loop", intervalSeconds: 600 },
      }),
      [404],
    );
    expect(denied.body.error.code).toBe("NOT_FOUND");

    // Switching to cron on a disabled automation keeps next run unscheduled
    // (the same gating creation applies).
    const created = await createAutomation({
      name: "disabled-retime",
      agentId: fixture.composeId,
      enabled: false,
      trigger: { kind: "loop", intervalSeconds: 300 },
    });
    const updated = await accept(
      triggerApi().update({
        params: { id: created.automation.triggers[0]!.id },
        headers: SESSION_HEADERS,
        body: { kind: "cron", cronExpression: "0 9 * * *" },
      }),
      [200],
    );
    if (updated.body.kind !== "cron") {
      throw new Error("Expected a cron trigger");
    }
    expect(updated.body.nextRunAt).toBeNull();
  });

  it("manually fires an automation: chat callback only, automation-only provenance", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "fire-now",
      agentId: fixture.composeId,
      instruction: "Manual run test",
      description: "Manual run description",
      appendSystemPrompt: "Use the run context.",
      trigger: { kind: "cron", cronExpression: "0 9 * * *" },
    });

    const runResponse = await accept(
      refApi().run({
        params: { ref: "fire-now" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [201],
    );
    const { runId } = runResponse.body;

    const db = store.set(writeDb$);
    // Provenance: the automation alone — no trigger fired this run. B2 is
    // deferred, so the run records the automation trigger source.
    const [zeroRun] = await db
      .select({
        triggerSource: zeroRuns.triggerSource,
        automationId: zeroRuns.automationId,
        triggerId: zeroRuns.triggerId,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, runId));
    expect(zeroRun).toStrictEqual({
      triggerSource: "automation",
      automationId: created.automation.id,
      triggerId: null,
      chatThreadId: created.automation.chatThreadId,
    });

    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(run?.prompt).toBe("Manual run test");
    expect(run?.appendSystemPrompt).toContain("Trigger type: manual");
    expect(run?.appendSystemPrompt).toContain("Use the run context.");

    // Only the chat callback: nothing was claimed, so there is no reschedule.
    const callbacks = await db
      .select({ url: agentRunCallbacks.url })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runId));
    expect(callbacks).toHaveLength(1);
    expect(
      callbacks[0]?.url.endsWith("/api/internal/callbacks/chat"),
    ).toBeTruthy();

    // The prompt renders as a user chat message with the automation chip.
    const messages = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        automationTitle: chatMessages.automationTitle,
        automationSnapshot: chatMessages.automationSnapshot,
      })
      .from(chatMessages)
      .where(eq(chatMessages.runId, runId));
    const chipMessage = messages.find((message) => {
      return message.role === "user" && message.content === "Manual run test";
    });
    expect(chipMessage).toMatchObject({
      automationTitle: "fire-now",
      automationSnapshot: { id: created.automation.id, title: "fire-now" },
    });
    // The manual run is stamped on the trigger, so a second fire conflicts
    // while it is still active (per-trigger skip-if-active semantics).
    const [trigger] = await findTriggerRows(created.automation.id);
    expect(trigger?.lastRunId).toBe(runId);
    const conflictResponse = await accept(
      refApi().run({
        params: { ref: "fire-now" },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [409],
    );
    expect(conflictResponse.body.error.code).toBe("CONFLICT");
  });

  it("manually fires a triggerless automation without a conflict check", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "triggerless-run",
      agentId: fixture.composeId,
    });
    const runResponse = await accept(
      refApi().run({
        params: { ref: created.automation.id },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [201],
    );

    const db = store.set(writeDb$);
    const [zeroRun] = await db
      .select({
        automationId: zeroRuns.automationId,
        triggerId: zeroRuns.triggerId,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, runResponse.body.runId));
    expect(zeroRun).toStrictEqual({
      automationId: created.automation.id,
      triggerId: null,
    });
  });

  it("rotates a webhook trigger's secret and rejects non-webhook rotation", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "rotate-me",
      agentId: fixture.composeId,
      trigger: { kind: "webhook" },
    });
    const triggerId = created.automation.triggers[0]!.id;
    const [before] = await findTriggerRows(created.automation.id);

    const rotated = await accept(
      triggerApi().rotateSecret({
        params: { id: triggerId },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [200],
    );
    expect(rotated.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.body.webhookSecret).not.toBe(created.webhookSecret);
    if (rotated.body.trigger.kind !== "webhook") {
      throw new Error("Expected a webhook trigger");
    }
    // Rotation replaces the secret but keeps the URL token (identity).
    expect(rotated.body.trigger.webhookToken).toBe(
      created.automation.triggers[0]?.kind === "webhook"
        ? created.automation.triggers[0].webhookToken
        : undefined,
    );

    const [after] = await findTriggerRows(created.automation.id);
    expect(after?.encryptedSecret).not.toBe(before?.encryptedSecret);
    expect(decryptSecretForTests(after!.encryptedSecret!)).toBe(
      rotated.body.webhookSecret,
    );

    const cronAdded = await accept(
      refApi().addTrigger({
        params: { ref: "rotate-me" },
        headers: SESSION_HEADERS,
        body: { kind: "cron", cronExpression: "0 9 * * *" },
      }),
      [201],
    );
    const rejected = await accept(
      triggerApi().rotateSecret({
        params: { id: cronAdded.body.trigger.id },
        headers: SESSION_HEADERS,
        body: {},
      }),
      [400],
    );
    expect(rejected.body.error.code).toBe("BAD_REQUEST");
  });

  it("deletes an automation and cascades its triggers; removes single triggers", async () => {
    const fixture = await seedFixture();
    await enableWebhookTriggers(fixture);

    const created = await createAutomation({
      name: "remove-me",
      agentId: fixture.composeId,
      trigger: { kind: "webhook" },
    });
    const added = await accept(
      refApi().addTrigger({
        params: { ref: "remove-me" },
        headers: SESSION_HEADERS,
        body: { kind: "loop", intervalSeconds: 300 },
      }),
      [201],
    );

    await accept(
      triggerApi().remove({
        params: { id: added.body.trigger.id },
        headers: SESSION_HEADERS,
      }),
      [204],
    );
    await expect(findTriggerRows(created.automation.id)).resolves.toHaveLength(
      1,
    );

    await accept(
      refApi().delete({
        params: { ref: "remove-me" },
        headers: SESSION_HEADERS,
      }),
      [204],
    );
    const db = store.set(writeDb$);
    const automationRows = await db
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.id, created.automation.id));
    expect(automationRows).toHaveLength(0);
    await expect(findTriggerRows(created.automation.id)).resolves.toHaveLength(
      0,
    );
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(mainApi().list({ headers: {} }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
