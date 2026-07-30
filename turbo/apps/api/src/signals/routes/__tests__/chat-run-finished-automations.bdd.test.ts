import { createHash, randomUUID } from "node:crypto";

import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { accept, setupApp } from "../../../__tests__/test-helpers";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";

/**
 * chat-run-finished workflow automations: creation validation and dispatch
 * from the terminal chat callback (real sandbox complete webhooks).
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const wf = createWorkflowsBddApi(context);

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

interface ChatAutomationFixture {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

async function setupChatAutomationFixture(): Promise<ChatAutomationFixture> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat run finished automation agent",
    description: "Exercises chat-run-finished automation dispatch.",
    visibility: "private",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: "chat-run-finished-workflow",
  });
  context.mocks.s3.send.mockResolvedValue({});
  return { actor, agentId: agent.agentId, workflowId, runnerGroup };
}

/**
 * Each automation gets its own workflow so it also gets its own automation
 * chat thread; automations sharing a workflow queue behind each other and
 * would not record `lastRunAt` until the prior automation run completes.
 */
async function createChatRunFinishedAutomation(
  fixture: ChatAutomationFixture,
  eventConfig: {
    readonly chatThreadId: string;
    readonly runStatuses?: readonly ("completed" | "failed" | "cancelled")[];
    readonly outputPattern?: string;
  },
): Promise<string> {
  const workflowId = await wf.createWorkflow(fixture.actor, {
    agentId: fixture.agentId,
    name: `crf-${randomUUID().slice(0, 8)}`,
  });
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: {
        kind: "event",
        eventType: "chat-run-finished",
        eventConfig: {
          provider: "chat",
          event: "run_finished",
          chatThreadId: eventConfig.chatThreadId,
          ...(eventConfig.runStatuses
            ? { runStatuses: [...eventConfig.runStatuses] }
            : {}),
          ...(eventConfig.outputPattern
            ? { outputPattern: eventConfig.outputPattern }
            : {}),
        },
      },
    }),
    [201],
  );
  expect(created.body).toMatchObject({
    kind: "event",
    eventType: "chat-run-finished",
    enabled: true,
  });
  return created.body.id;
}

async function automationLastRunAt(automationId: string): Promise<unknown> {
  const automation = await accept(
    automationsClient().get({
      headers: authHeaders(),
      params: { id: automationId },
    }),
    [200],
  );
  return automation.body.lastRunAt;
}

async function startWatchedChatRun(
  fixture: ChatAutomationFixture,
  prompt: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      prompt,
      clientEventId: randomUUID(),
      model: "claude-sonnet-4-6",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{ readonly authorization: string }> {
  await api.heartbeatRunner(runnerGroup);
  let claim: Awaited<ReturnType<typeof api.requestClaimRunnerJob>> | undefined;
  await expect
    .poll(
      async () => {
        claim = await api.requestClaimRunnerJob(true, runId, [200, 404]);
        return claim.status;
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBe(200);
  if (!claim || claim.status !== 200) {
    throw new Error("Expected the chat run to be claimable");
  }
  return { authorization: `Bearer ${claim.body.sandboxToken}` };
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`chat run finished bdd session history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-cli-${runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      ...(options.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: options.lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

async function expectAutomationFired(automationId: string): Promise<void> {
  await expect
    .poll(
      () => {
        return automationLastRunAt(automationId);
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBeTruthy();
}

describe("chat-run-finished workflow automations", () => {
  it("requires the watched chat thread to belong to the automation owner", async () => {
    const fixture = await setupChatAutomationFixture();

    const missingThread = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: randomUUID(),
          },
        },
      }),
      [400],
    );
    expect(missingThread.body.error.message).toContain("Chat thread not found");

    const otherUser = bdd.user({
      orgId: fixture.actor.orgId ?? undefined,
      orgRole: "org:member",
    });
    const otherAgent = await bdd.createAgent(otherUser, {
      displayName: "Other member agent",
      visibility: "private",
    });
    const otherThread = await chat.createThread(otherUser, {
      agentId: otherAgent.agentId,
      model: "claude-sonnet-4-6",
    });
    // Restore the fixture actor's session after acting as the other member.
    await bdd.readMe(fixture.actor);
    const foreignThread = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: otherThread.id,
          },
        },
      }),
      [400],
    );
    expect(foreignThread.body.error.message).toContain("Chat thread not found");
  });

  it(
    "fires claimable matching automations when a watched run completes",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(fixture, "watched completed run");

      const fireAlways = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
      });
      const failedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
      });
      const patternMatch = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["completed"],
        outputPattern: "*deploy failed*",
      });
      const patternMiss = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        outputPattern: "*all systems nominal*",
      });

      chatCallbacks.mockChatOutputEvents([
        {
          eventType: "assistant",
          sequenceNumber: 0,
          eventData: {
            message: {
              content: [{ type: "text", text: "Alert: Deploy FAILED on prod" }],
            },
          },
        },
      ]);
      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await completeChatRunOk(run.runId, sandboxHeaders, {
        lastEventSequence: 0,
      });

      await expectAutomationFired(fireAlways);
      await expectAutomationFired(patternMatch);
      await expect(automationLastRunAt(failedOnly)).resolves.toBeNull();
      await expect(automationLastRunAt(patternMiss)).resolves.toBeNull();

      const automationRuns = await api.listAgentRuns(fixture.actor, {
        status: "pending",
        limit: 20,
      });
      expect(automationRuns.runs).toHaveLength(2);
      const automationRunId = automationRuns.runs[0]?.id;
      if (!automationRunId) {
        throw new Error("Expected a triggered automation run");
      }
      await claimChatRun(fixture.runnerGroup, automationRunId);
    },
  );

  it(
    "fires failed-status automations without matching patterns on errors",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(fixture, "watched failed run");

      const failedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
      });
      const completedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["completed"],
      });
      const failedWithPattern = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
        outputPattern: "*boom*",
      });

      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1, error: "boom: sandbox exploded" },
        sandboxHeaders,
        [200],
      );

      await expectAutomationFired(failedOnly);
      await expect(automationLastRunAt(completedOnly)).resolves.toBeNull();
      // Error messages are not matchable output, so pattern automations stay
      // silent even when the error text would match.
      await expect(automationLastRunAt(failedWithPattern)).resolves.toBeNull();
    },
  );
});
