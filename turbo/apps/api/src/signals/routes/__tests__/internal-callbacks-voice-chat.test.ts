import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { voiceChatItems, voiceChatTasks } from "@vm0/db/schema/voice-chat";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { clearAllDetached } from "../../utils";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  addVoiceChatSession$,
  deleteVoiceChatFixture$,
  seedVoiceChatAgent$,
  seedVoiceChatFixture$,
  seedVoiceChatTask$,
  type VoiceChatFixture,
} from "./helpers/zero-voice-chat";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

const PATH = "/api/internal/callbacks/voice-chat";
const TEST_CALLBACK_SECRET = "test-callback-secret";

interface VoiceChatCallbackFixture extends VoiceChatFixture {
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly callbackId: string;
}

const track = createFixtureTracker<VoiceChatFixture>((fixture) => {
  return store.set(deleteVoiceChatFixture$, fixture, context.signal);
});

async function seedVoiceChatCallbackFixture(args: {
  readonly agentIdOnRun?: string;
}): Promise<VoiceChatCallbackFixture> {
  const fixture = await track(
    store.set(seedVoiceChatFixture$, {}, context.signal),
  );
  const agentId = await store.set(
    seedVoiceChatAgent$,
    fixture,
    {},
    context.signal,
  );
  const sessionId = await store.set(
    addVoiceChatSession$,
    fixture,
    { agentId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: agentId,
      triggerSource: "voice-chat",
      status: "running",
      lastEventSequence: 7,
    },
    context.signal,
  );
  const db = store.set(writeDb$);
  await db
    .update(agentRuns)
    .set({ vars: { ZERO_AGENT_ID: args.agentIdOnRun ?? agentId } })
    .where(eq(agentRuns.id, runId));
  const taskId = await store.set(
    seedVoiceChatTask$,
    sessionId,
    { status: "queued", runId },
    context.signal,
  );
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${PATH}`,
      payload: { taskId },
    },
    context.signal,
  );

  return { ...fixture, agentId, sessionId, runId, taskId, callbackId };
}

function signedHeaders(
  rawBody: string,
  secret = TEST_CALLBACK_SECRET,
  timestamp = Math.floor(now() / 1000),
) {
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, timestamp),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postSignedCallback(
  body: Record<string, unknown>,
  secret?: string,
  timestamp?: number,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const app = createApp({ signal: context.signal });
  return await app.request(PATH, {
    method: "POST",
    headers: signedHeaders(rawBody, secret, timestamp),
    body: rawBody,
  });
}

async function getTask(taskId: string) {
  const db = store.set(writeDb$);
  const [task] = await db
    .select()
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.id, taskId))
    .limit(1);
  return task ?? null;
}

async function listItems(sessionId: string) {
  const db = store.set(writeDb$);
  return await db
    .select()
    .from(voiceChatItems)
    .where(eq(voiceChatItems.sessionId, sessionId));
}

function completedOutput(text: string): void {
  context.mocks.axiom.query
    .mockResolvedValueOnce(
      Array.from({ length: 8 }, (_, sequenceNumber) => {
        return { sequenceNumber };
      }),
    )
    .mockResolvedValueOnce([
      {
        eventType: "result",
        eventData: { result: text },
      },
    ]);
}

describe("POST /api/internal/callbacks/voice-chat", () => {
  it("returns 200 for progress status without touching the task", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: { taskId: fixture.taskId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    await expect(getTask(fixture.taskId)).resolves.toMatchObject({
      status: "queued",
    });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("completes the task and writes a task_result item on completed", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});
    completedOutput("final answer");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { taskId: fixture.taskId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const task = await getTask(fixture.taskId);
    expect(task).toMatchObject({
      status: "done",
      error: null,
      result: "final answer",
    });
    expect(task?.assistantMessages).toStrictEqual([
      { type: "assistant", content: "final answer", at: expect.any(String) },
    ]);

    const items = await listItems(fixture.sessionId);
    expect(
      items.some((item) => {
        return (
          item.role === "task_result" &&
          item.taskId === fixture.taskId &&
          item.content?.includes("final answer") === true
        );
      }),
    ).toBeTruthy();

    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `voice-chat:${fixture.sessionId}`,
      null,
    );
    await clearAllDetached();
  });

  it("marks the task failed and records the callback error on failed", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "runner crashed",
      payload: { taskId: fixture.taskId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const task = await getTask(fixture.taskId);
    expect(task).toMatchObject({
      status: "failed",
      error: "runner crashed",
      result: null,
    });

    const items = await listItems(fixture.sessionId);
    expect(
      items.some((item) => {
        return (
          item.role === "task_result" &&
          item.taskId === fixture.taskId &&
          item.content?.includes("runner crashed") === true
        );
      }),
    ).toBeTruthy();
    await clearAllDetached();
  });

  it("rejects requests with invalid signatures", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});

    const response = await postSignedCallback(
      {
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "completed",
        payload: { taskId: fixture.taskId },
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
    await expect(getTask(fixture.taskId)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("rejects requests with expired timestamps", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});
    const expiredTimestamp = Math.floor(now() / 1000) - 10 * 60;

    const response = await postSignedCallback(
      {
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "completed",
        payload: { taskId: fixture.taskId },
      },
      TEST_CALLBACK_SECRET,
      expiredTimestamp,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Timestamp expired",
    });
    await expect(getTask(fixture.taskId)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("returns 404 for callbacks without a matching callback record", async () => {
    const response = await postSignedCallback({
      runId: randomUUID(),
      status: "completed",
      payload: { taskId: randomUUID() },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Callback not found",
    });
  });

  it("rejects callback bodies missing runId", async () => {
    const response = await postSignedCallback({
      status: "completed",
      payload: { taskId: randomUUID() },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing runId",
    });
  });

  it("returns 400 when payload is missing taskId", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: {},
    });

    expect(response.status).toBe(400);
    await expect(getTask(fixture.taskId)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("fails the task with a system note on agent mismatch", async () => {
    const fixture = await seedVoiceChatCallbackFixture({
      agentIdOnRun: randomUUID(),
    });
    completedOutput("ignored answer");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { taskId: fixture.taskId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const task = await getTask(fixture.taskId);
    expect(task).toMatchObject({
      status: "failed",
      error: "agent mismatch",
    });
    const items = await listItems(fixture.sessionId);
    expect(
      items.some((item) => {
        return (
          item.role === "system_note" &&
          item.taskId === fixture.taskId &&
          item.content?.toLowerCase().includes("agent mismatch") === true
        );
      }),
    ).toBeTruthy();
    await clearAllDetached();
  });

  it("completes the task with an empty result when output extraction fails", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});
    context.mocks.axiom.query.mockRejectedValueOnce(new Error("axiom down"));

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { taskId: fixture.taskId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const task = await getTask(fixture.taskId);
    expect(task).toMatchObject({
      status: "done",
      error: null,
      result: null,
    });
    expect(task?.assistantMessages).toStrictEqual([]);

    const items = await listItems(fixture.sessionId);
    expect(
      items.some((item) => {
        return (
          item.role === "task_result" &&
          item.taskId === fixture.taskId &&
          item.content === "[task returned empty result]"
        );
      }),
    ).toBeTruthy();
    await clearAllDetached();
  });

  it("returns 200 for an unknown taskId", async () => {
    const fixture = await seedVoiceChatCallbackFixture({});

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { taskId: randomUUID() },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    await expect(getTask(fixture.taskId)).resolves.toMatchObject({
      status: "queued",
    });
  });
});
