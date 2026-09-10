import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  withContractedGoalSchema,
  seedRetainedRunProvenance,
  removeSnapshottedRunEvents,
  retainedUsageRows,
} from "../../../test-fixtures/goal-schema-contraction";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRouteMocks } from "./helpers/route-test";
import { installFakeChatEventR2 } from "./helpers/fake-chat-event-r2";

const context = testContext();
createRouteMocks(context);
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);

async function archive(threadId: string): Promise<void> {
  const previous = context.mocks.s3.send.getMockImplementation();
  installFakeChatEventR2(context);
  const snapshot = context.mocks.s3.send.getMockImplementation();
  if (!previous || !snapshot) {
    throw new Error("Expected object storage fixtures");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      (command instanceof GetObjectCommand ||
        command instanceof PutObjectCommand) &&
      command.input.Key?.startsWith("chat-events/")
    ) {
      return snapshot(command);
    }
    return previous(command);
  });
  await accept(
    setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
      testChatEventSearchProjectionContract,
    ).project({ body: { chat_thread_ids: [threadId] } }),
    [200],
  );
  await accept(
    setupApp({ context, routes: testChatEventSnapshotRoutes })(
      testChatEventSnapshotContract,
    ).snapshot({ body: { chat_thread_ids: [threadId], r2_object_keys: [] } }),
    [200],
  );
  await removeSnapshottedRunEvents(threadId);
}

test("executes normal and CTE launches, callbacks and late historical billing after Goal schema contraction", async () => {
  await withContractedGoalSchema(async (statements) => {
    const actor = bdd.user();
    const callbacks = createChatCallbacksApi(context);
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Consumer-free runtime",
      visibility: "private",
    });
    const send = async () => {
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "ordinary chat after contraction",
          model: "claude-sonnet-5",
        },
        [201],
      );
      if (response.status !== 201 || !response.body.runId) {
        throw new Error("Expected a persisted run");
      }
      await flushWaitUntilForTest();
      return { runId: response.body.runId, threadId: response.body.threadId };
    };
    // No configured runner: preparation failure exercises the ordinary insert
    // and metadata path, retaining the real failed run and its terminal callback.
    const failed = await send();
    expect((await api.readRun(actor, failed.runId)).status).toBe("failed");
    const runnerGroup = api.configureRunnerGroup();
    await api.heartbeatRunner(runnerGroup);
    const provider = `contraction-${randomUUID()}`;
    await seedUsagePricingRows([
      {
        kind: "connector",
        provider,
        category: "api_request",
        unitPrice: 7,
        unitSize: 1,
      },
    ]);
    for (const provenance of ["hot", "snapshot", "absent"] as const) {
      const run = await send();
      expect((await api.readRun(actor, run.runId)).status).toBe("pending");
      const claim = await api.claimRunnerJob(run.runId);
      const headers = { authorization: `Bearer ${claim.sandboxToken}` };
      const groupId = provenance === "absent" ? null : randomUUID();
      await seedRetainedRunProvenance(run.runId, run.threadId, groupId);
      // This is a callback from an already-claimed historical run, not a new
      // Goal claim. Its status and output still settle exactly once.
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "historical terminal callback",
        },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      expect((await api.readRun(actor, run.runId)).status).toBe("failed");
      const terminal = (
        await chat.listThreadEvents(actor, run.threadId)
      ).events.filter((event) => {
        return event.eventType === "run.failed";
      });
      expect(terminal).toHaveLength(1);
      if (provenance === "snapshot") {
        await archive(run.threadId);
      }
      const record = async (key: string) => {
        await webhooks.requestAgentUsageEvent(
          {
            runId: run.runId,
            events: [
              {
                idempotencyKey: key,
                kind: "connector",
                provider,
                category: "api_request",
                quantity: 1,
              },
            ],
          },
          headers,
          [200],
        );
        await createBillingMediaApi(context).processOrgUsageEvents(actor);
        await flushWaitUntilForTest();
      };
      const firstKey = randomUUID();
      await record(firstKey);
      const [first] = await retainedUsageRows(run.runId);
      expect(first).toMatchObject({
        contextType: groupId ? "goal" : null,
        contextId: groupId,
        payload: { usage: { totalCredits: 7 } },
      });
      if (!first) {
        throw new Error("Expected first late usage");
      }
      await record(firstKey);
      await expect(retainedUsageRows(run.runId)).resolves.toHaveLength(1);
      // Revisions inherit even a null pointer; subsequent unrelated provenance
      // must not silently regroup an already-authoritative usage event.
      if (provenance === "absent") {
        await seedRetainedRunProvenance(run.runId, run.threadId, randomUUID());
      }
      if (provenance === "snapshot") {
        await archive(run.threadId);
      }
      const secondKey = randomUUID();
      await record(secondKey);
      const revisions = await retainedUsageRows(run.runId);
      const revised = revisions.at(-1);
      expect(revised).toMatchObject({
        revokesEventId: first.id,
        contextType: first.contextType,
        contextId: first.contextId,
        payload: {
          usage: {
            totalCredits: 14,
            settledAt: first.payload?.usage?.settledAt,
          },
        },
      });
      expect(revised?.createdAt.getTime()).toBeGreaterThan(
        first.createdAt.getTime(),
      );
      await record(secondKey);
      await expect(retainedUsageRows(run.runId)).resolves.toStrictEqual(
        revisions,
      );
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "historical terminal callback",
        },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      await expect(retainedUsageRows(run.runId)).resolves.toStrictEqual(
        revisions,
      );
    }
    const sql = statements();
    expect(
      sql.some((statement) => {
        return /^insert into "agent_runs"/i.test(statement);
      }),
    ).toBeTruthy();
    expect(
      sql.some((statement) => {
        return (
          /^with /i.test(statement) &&
          statement.includes('insert into "agent_runs"')
        );
      }),
    ).toBeTruthy();
    expect(
      sql.filter((statement) => {
        return /\b(goal_id|thread_goals|retirement_archive_event_id|retirement_search_materialized_at)\b/i.test(
          statement,
        );
      }),
    ).toStrictEqual([]);
    expect(
      sql.some((statement) => {
        return statement.includes('update "agent_runs"');
      }),
    ).toBeTruthy();
  });
}, 180_000);
