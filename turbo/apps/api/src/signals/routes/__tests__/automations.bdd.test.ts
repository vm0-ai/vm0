import { randomUUID } from "node:crypto";

import { automationTriggers } from "@vm0/db/schema/automation";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createRunsSchedulesApi,
  signAutomationWebhook,
  uniqueScheduleName,
} from "./helpers/api-bdd-runs-schedules";

/**
 * AUTOMATIONS-02/03 and HOOK-02: the events-first automations surface (feature
 * gating, run-now dispatch) and webhook automations driven by signed inbound
 * HTTP. The AUTOMATIONS-01 lifecycle chain lives in runs-schedules.bdd.test.ts;
 * the HOOK-02 management happy chain lives in hooks-ops.bdd.test.ts.
 *
 * Shared-database isolation: this file never calls cron-execute-schedules (or
 * any other cron route) — those global sweeps are owned by
 * runs-schedules.bdd.test.ts. Every time automation created here is
 * enabled:false (runScheduleNow$ has no enabled gate, and a disabled row can
 * never be claimed by a foreign worker's execute-schedules sweep) and webhook
 * automations have no zero_agent_schedules row at all. No mockNow anywhere:
 * nothing here depends on due-time math.
 *
 * Run provenance (zeroRuns.automationId/triggerId) has no API read surface;
 * the dispatch is asserted through its visible effects instead (chat-thread
 * user message carrying the runId plus the runner-claim render). If a
 * provenance read API appears, promote it to a visible Then.
 */

const context = testContext();
const store = createStore();

async function entitledAutomationActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsSchedulesApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD automation agent",
    description: "Exercises the automations API surface.",
    visibility: "private",
  });
  await api.enableAutomations(actor);
  return { actor, agentId: agent.agentId, runnerGroup };
}

interface ThreadMessageView {
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly runId?: string;
}

function automationRunIdFromThread(
  messages: readonly ThreadMessageView[],
  prompt: string,
): string {
  const runId = messages.find((message) => {
    return message.role === "user" && message.content === prompt;
  })?.runId;
  if (!runId) {
    throw new Error("Expected an automation user message carrying a runId");
  }
  return runId;
}

describe("AUTOMATIONS-02: webhook trigger feature-switch gating", () => {
  it("keeps webhook trigger creation gated while the automation resource stays mounted", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);

    // Given a fresh user whose org/user has no webhook-trigger override (the
    // switch defaults to off). First test in this file: install the ably
    // default explicitly because mock defaults are only installed by afterEach.
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const actor = bdd.user();

    // Then listing automations is mounted even before webhook triggers are on.
    const list = await api.requestListAutomationsRaw(actor);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ automations: [] });

    // When/Then creating a webhook automation reports a visible bad request.
    const webhookCreate = await api.requestCreateWebhookAutomationUnchecked(
      actor,
      {
        name: "gated-webhook",
        instruction: "Should not be created.",
        agentId: randomUUID(),
      },
      [400],
    );
    expectApiError(webhookCreate.body);
    expect(webhookCreate.body.error.code).toBe("BAD_REQUEST");

    // Given the webhook trigger switch is explicitly off
    const triggerGatedActor = bdd.user();
    await api.enableAutomations(triggerGatedActor, {
      webhookTriggers: false,
    });

    // When/Then creating a webhook automation still reports bad request.
    const webhookTriggerCreate =
      await api.requestCreateWebhookAutomationUnchecked(
        triggerGatedActor,
        {
          name: "gated-webhook-trigger",
          instruction: "Should not be created.",
          agentId: randomUUID(),
        },
        [400],
      );
    expectApiError(webhookTriggerCreate.body);
    expect(webhookTriggerCreate.body.error.code).toBe("BAD_REQUEST");

    // Then the unauthenticated boundary still reports unauthorized rather
    // than the gated bad request.
    const unauthenticated = await api.requestListWebhookAutomations(
      null,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTOMATIONS-03: automation run-now dispatch", () => {
  it("dispatches a run-now automation visible through chat, claim, and queue", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);

    // Given an entitled actor with the automations switch on
    const { actor, agentId, runnerGroup } = await entitledAutomationActor();
    const prompt = `Run the automation report ${randomUUID().slice(0, 8)}.`;
    const automationName = uniqueScheduleName("bdd-auto-run");

    // When the actor creates a disabled cron automation (enabled:false keeps
    // the row invisible to any foreign execute-schedules sweep on the shared
    // database; run-now has no enabled gate)
    const created = await api.createAutomation(actor, {
      name: automationName,
      agentId,
      cronExpression: "0 9 * * *",
      prompt,
      appendSystemPrompt: "Automation tone.",
      timezone: "UTC",
      enabled: false,
    });
    expect(created.created).toBeTruthy();
    const automation = created.automation;

    // Then the automation is visible through list
    const listed = await api.listAutomations(actor);
    expect(
      listed.automations.some((item) => {
        return item.id === automation.id;
      }),
    ).toBeTruthy();

    // When the actor runs the automation now
    const runNow = await api.requestRunAutomation(actor, automation.id, [201]);
    if (runNow.status !== 201) {
      throw new Error("Expected the automation run-now to create a run");
    }
    const runId = runNow.body.runId;

    // Then the linked chat thread carries the prompt as a user message bound
    // to the created run
    const thread = await chat.listThreadMessages(
      actor,
      automation.chatThreadId,
    );
    expect(automationRunIdFromThread(thread.messages, prompt)).toBe(runId);

    // When the runner claims the dispatched run
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);

    // Then the claim renders the schedule-interpreter context through the
    // automations surface
    expect(claim.prompt).toBe(prompt);
    expect(claim.appendSystemPrompt).toContain(
      "You are currently running inside: Schedule",
    );
    expect(claim.appendSystemPrompt).toContain("Trigger type: manual");
    expect(claim.appendSystemPrompt).toContain("Automation tone.");

    // Then a second run-now conflicts while the previous run is still active
    const conflict = await api.requestRunAutomation(
      actor,
      automation.id,
      [409],
    );
    expectApiError(conflict.body);
    expect(conflict.body.error.code).toBe("CONFLICT");

    // Then the run is terminal-ized and the org queue drains
    await api.requestCancelRun(actor, runId, [200]);
    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.active).toBe(0);

    // When a disabled loop automation is run now, the manual fire still
    // belongs to the automation rather than to a specific trigger.
    const loopCreated = await api.createAutomation(actor, {
      name: uniqueScheduleName("bdd-auto-loop"),
      agentId,
      intervalSeconds: 300,
      prompt,
      timezone: "UTC",
      enabled: false,
    });
    expect(loopCreated.created).toBeTruthy();
    const loopRun = await api.requestRunAutomation(
      actor,
      loopCreated.automation.id,
      [201],
    );
    if (loopRun.status !== 201) {
      throw new Error("Expected the loop automation run-now to create a run");
    }

    // Then the claim renders the manual trigger context, and the run drains.
    const loopClaim = await api.claimRunnerJob(loopRun.body.runId);
    expect(loopClaim.appendSystemPrompt).toContain("Trigger type: manual");
    await api.requestCancelRun(actor, loopRun.body.runId, [200]);
    await api.deleteAutomation(actor, loopCreated.automation);

    // Then updating a missing automation reports not-found
    const updateMissingAutomation = await api.requestUpdateAutomationUnchecked(
      actor,
      uniqueScheduleName("bdd-missing-auto"),
      {
        prompt,
      },
      [404],
    );
    expectApiError(updateMissingAutomation.body);
    expect(updateMissingAutomation.body.error.code).toBe("NOT_FOUND");

    // Cleanup: delete the automation and verify it left the list
    await api.deleteAutomation(actor, automation);
    const afterDelete = await api.listAutomations(actor);
    expect(
      afterDelete.automations.some((item) => {
        return item.id === automation.id;
      }),
    ).toBeFalsy();
  });
});

describe("HOOK-02: webhook automations fired by signed inbound HTTP", () => {
  it("manages webhook automations and fires a signed inbound payload into a run", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);

    // Given an entitled actor with two agents, plus an outsider with the
    // switch on
    const { actor, agentId, runnerGroup } = await entitledAutomationActor();
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD webhook second agent",
      description: "Holds a chat thread on a different agent.",
      visibility: "private",
    });
    const outsider = bdd.user();
    await api.enableAutomations(outsider);

    // When creating a webhook automation against a missing agent
    const missingAgent = await api.requestCreateWebhookAutomationUnchecked(
      actor,
      {
        name: uniqueScheduleName("bdd-hook-missing-agent"),
        instruction: "Handle it.",
        agentId: randomUUID(),
      },
      [404],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.code).toBe("NOT_FOUND");

    // When linking an owned thread that belongs to a different agent
    const threadOnAgentB = await chat.createThread(actor, {
      agentId: agentB.agentId,
    });
    const wrongAgentThread = await api.requestCreateWebhookAutomationUnchecked(
      actor,
      {
        name: uniqueScheduleName("bdd-hook-wrong-thread"),
        instruction: "Handle it.",
        agentId,
        chatThreadId: threadOnAgentB.id,
      },
      [400],
    );
    expectApiError(wrongAgentThread.body);
    expect(wrongAgentThread.body.error.code).toBe("BAD_REQUEST");

    // When linking an owned thread on the same agent
    const ownedThread = await chat.createThread(actor, { agentId });
    const linked = await api.createWebhookAutomation(actor, {
      name: uniqueScheduleName("bdd-hook-linked"),
      instruction: "Summarize linked events.",
      agentId,
      chatThreadId: ownedThread.id,
    });
    expect(linked.automation.chatThreadId).toBe(ownedThread.id);

    // Then deletes stay scoped to the owner
    const outsiderDelete = await api.requestDeleteWebhookAutomation(
      outsider,
      linked.automation.id,
      [404],
    );
    expectApiError(outsiderDelete.body);
    expect(outsiderDelete.body.error.code).toBe("NOT_FOUND");
    const missingDelete = await api.requestDeleteWebhookAutomation(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(missingDelete.body);
    expect(missingDelete.body.error.code).toBe("NOT_FOUND");

    // When minting the main webhook automation
    const instruction = `Summarize the incoming webhook event ${randomUUID().slice(0, 8)}.`;
    const created = await api.createWebhookAutomation(actor, {
      name: uniqueScheduleName("bdd-hook-main"),
      instruction,
      description: "On deploy",
      agentId,
    });

    // Then the secret is minted once and the inbound URL carries the token
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.automation.webhookToken).toMatch(/^whk_[0-9a-f]{48}$/);
    expect(created.automation.webhookUrl).toBe(
      `http://localhost:3000/api/automations/webhooks/${created.automation.webhookToken}`,
    );
    expect(created.automation.enabled).toBeTruthy();

    const token = created.automation.webhookToken;
    const body = JSON.stringify({ event: "ping", value: 42 });

    // Then a payload signed with the wrong secret is unauthorized
    const badSignature = await api.postAutomationWebhook(token, body, {
      signature: signAutomationWebhook("wrong-secret", body),
    });
    expect(badSignature.status).toBe(401);

    // Then a payload with no signature header is unauthorized
    const noSignature = await api.postAutomationWebhook(token, body);
    expect(noSignature.status).toBe(401);

    // Then an unknown token is not found
    const unknownToken = await api.postAutomationWebhook(
      `whk_${randomUUID().replace(/-/g, "")}`,
      body,
      { signature: signAutomationWebhook(created.secret, body) },
    );
    expect(unknownToken.status).toBe(404);

    // Then a disabled automation is indistinguishable from a missing one
    const disabled = await api.createWebhookAutomation(actor, {
      name: uniqueScheduleName("bdd-hook-disabled"),
      instruction: "Should never fire.",
      agentId,
      enabled: false,
    });
    const disabledPost = await api.postAutomationWebhook(
      disabled.automation.webhookToken,
      body,
      { signature: signAutomationWebhook(disabled.secret, body) },
    );
    expect(disabledPost.status).toBe(404);

    const db = store.set(writeDb$);
    await db
      .update(automationTriggers)
      .set({ enabled: false })
      .where(eq(automationTriggers.automationId, created.automation.id));
    const disabledTriggerPost = await api.postAutomationWebhook(token, body, {
      signature: signAutomationWebhook(created.secret, body),
    });
    expect(disabledTriggerPost.status).toBe(404);
    await db
      .update(automationTriggers)
      .set({ enabled: true })
      .where(eq(automationTriggers.automationId, created.automation.id));

    await api.enableAutomations(actor, { webhookTriggers: false });
    const triggerGatePost = await api.postAutomationWebhook(token, body, {
      signature: signAutomationWebhook(created.secret, body),
    });
    expect(triggerGatePost.status).toBe(404);
    await api.enableAutomations(actor);

    // When a correctly signed payload hits the inbound route
    const fired = await api.postAutomationWebhook(token, body, {
      signature: signAutomationWebhook(created.secret, body),
      extraHeaders: { "x-custom-header": "header-value" },
    });
    expect(fired.status).toBe(200);
    expect(fired.body).toBe("OK");

    // Then the instruction is posted as a user message bound to the run
    const thread = await chat.listThreadMessages(
      actor,
      created.automation.chatThreadId,
    );
    const runId = automationRunIdFromThread(thread.messages, instruction);

    // Then the runner claim renders the webhook payload into the run context
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);
    expect(claim.prompt).toBe(instruction);
    expect(claim.appendSystemPrompt).toContain(
      "You are currently running inside: Webhook automation",
    );
    expect(claim.appendSystemPrompt).toContain('"event": "ping"');
    expect(claim.appendSystemPrompt).toContain('"x-custom-header"');

    // Then the run is terminal-ized and the org queue drains
    await api.requestCancelRun(actor, runId, [200]);
    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.active).toBe(0);

    // Cleanup: delete every webhook automation created here and verify the
    // list no longer carries them
    await api.deleteWebhookAutomation(actor, linked.automation.id);
    await api.deleteWebhookAutomation(actor, created.automation.id);
    await api.deleteWebhookAutomation(actor, disabled.automation.id);
    const deletedIds = new Set([
      linked.automation.id,
      created.automation.id,
      disabled.automation.id,
    ]);
    const afterDelete = await api.listWebhookAutomations(actor);
    expect(
      afterDelete.automations.some((automation) => {
        return deletedIds.has(automation.id);
      }),
    ).toBeFalsy();
  });

  it("surfaces run-creation failure of a signed dispatch as a throttled 429", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);

    // Given a free-tier actor with no entitlement and no model provider
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD free webhook agent",
      description: "Covers the run-creation failure arm of the dispatch.",
      visibility: "private",
    });
    await api.enableAutomations(actor);

    // When a correctly signed payload fires the automation
    const created = await api.createWebhookAutomation(actor, {
      name: uniqueScheduleName("bdd-hook-free"),
      instruction: "Will not start.",
      agentId: agent.agentId,
    });
    const body = JSON.stringify({ event: "ping" });
    const throttled = await api.postAutomationWebhook(
      created.automation.webhookToken,
      body,
      { signature: signAutomationWebhook(created.secret, body) },
    );

    // Then run admission fails for the free org and the dispatch reports a
    // throttled run-creation failure
    expect(throttled.status).toBe(429);
    expect(throttled.body).toStrictEqual({
      error: "Failed to start automation run",
    });

    // Cleanup
    await api.deleteWebhookAutomation(actor, created.automation.id);
  });
});
