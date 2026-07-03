import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createRunsAutomationsApi,
  uniqueAutomationName,
} from "./helpers/api-bdd-runs-automations";

/**
 * AUTOMATIONS-03: the events-first automations surface run-now dispatch. The
 * AUTOMATIONS-01 lifecycle chain lives in runs-schedules.bdd.test.ts.
 *
 * Shared-database isolation: this file never calls cron-execute-schedules (or
 * any other cron route) — those global sweeps are owned by
 * runs-schedules.bdd.test.ts. Every time automation created here is
 * enabled:false (runAutomationNow$ has no enabled gate, and a disabled row can
 * never be claimed by a foreign worker's execute-schedules sweep). No mockNow
 * anywhere: nothing here depends on due-time math.
 *
 * Run provenance (zeroRuns.automationId/triggerId) has no API read surface;
 * the dispatch is asserted through its visible effects instead (chat-thread
 * user message carrying the runId plus the runner-claim render). If a
 * provenance read API appears, promote it to a visible Then.
 */

const context = testContext();

async function entitledAutomationActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsAutomationsApi(context);
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

describe("AUTOMATIONS-03: automation run-now dispatch", () => {
  it("dispatches a run-now automation visible through chat, claim, and queue", async () => {
    const api = createRunsAutomationsApi(context);
    const chat = createChatFilesBddApi(context);

    // Given an entitled actor with the automations switch on
    const { actor, agentId, runnerGroup } = await entitledAutomationActor();
    const prompt = `Run the automation report ${randomUUID().slice(0, 8)}.`;
    const automationName = uniqueAutomationName("bdd-auto-run");

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
      "You are currently running inside: Automation",
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
      name: uniqueAutomationName("bdd-auto-loop"),
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
      uniqueAutomationName("bdd-missing-auto"),
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
