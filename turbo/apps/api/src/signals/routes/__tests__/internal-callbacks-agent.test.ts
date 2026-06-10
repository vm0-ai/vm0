import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();

const PATH = "/api/internal/callbacks/agent";
const TEST_CALLBACK_SECRET = "test-callback-secret";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface AgentCallbackFixture extends UsageInsightFixture {
  readonly composeId: string;
}

async function deleteFixture(fixture: AgentCallbackFixture): Promise<void> {
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function seedFixture(): Promise<AgentCallbackFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId: base.orgId,
      userId: base.userId,
      name: `agent-callback-${randomUUID().slice(0, 8)}`,
    },
    context.signal,
  );
  return { ...base, composeId };
}

async function seedAgentRun(fixture: AgentCallbackFixture): Promise<{
  readonly runId: string;
  readonly callbackId: string;
}> {
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: fixture.composeId,
      prompt: "Delegate this task to the other agent",
      triggerSource: "agent",
    },
    context.signal,
  );
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${PATH}`,
      payload: {},
    },
    context.signal,
  );
  return { runId, callbackId };
}

function signedHeaders(
  rawBody: string,
  secret = TEST_CALLBACK_SECRET,
): Record<string, string> {
  const timestamp = Math.floor(now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, timestamp),
    "X-VM0-Timestamp": String(timestamp),
  };
}

function postCallback(body: Record<string, unknown>, secret?: string) {
  const rawBody = JSON.stringify(body);
  const app = createApp({ signal: context.signal });
  return app.request(PATH, {
    method: "POST",
    headers: signedHeaders(rawBody, secret),
    body: rawBody,
  });
}

async function runSummary(runId: string): Promise<string | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ summary: zeroRuns.summary })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.summary ?? null;
}

describe("POST /api/internal/callbacks/agent", () => {
  const track = createFixtureTracker<AgentCallbackFixture>((fixture) => {
    return deleteFixture(fixture);
  });

  it("rejects requests with invalid signatures", async () => {
    const fixture = await track(seedFixture());
    const { runId, callbackId } = await seedAgentRun(fixture);

    const response = await postCallback(
      { callbackId, runId, status: "completed", payload: {} },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
  });

  it("returns 404 when no callback record exists", async () => {
    const response = await postCallback({
      runId: "00000000-0000-0000-0000-000000000000",
      status: "completed",
      payload: {},
    });

    expect(response.status).toBe(404);
  });

  it("returns success without mutating the run for progress callbacks", async () => {
    const fixture = await track(seedFixture());
    const { runId, callbackId } = await seedAgentRun(fixture);

    const response = await postCallback({
      callbackId,
      runId,
      status: "progress",
      payload: {},
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(runId)).resolves.toBeNull();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("generates and persists a summary for completed callbacks", async () => {
    const fixture = await track(seedFixture());
    const { runId, callbackId } = await seedAgentRun(fixture);
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        eventType: "result",
        eventData: { result: "Task completed successfully." },
      },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [{ message: { content: "Agent delegated the task." } }],
        });
      }),
    );

    const response = await postCallback({
      callbackId,
      runId,
      status: "completed",
      payload: {},
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(runId)).resolves.toBe("Agent delegated the task.");
  });

  it("returns success without a summary when the lightweight model is unavailable", async () => {
    const fixture = await track(seedFixture());
    const { runId, callbackId } = await seedAgentRun(fixture);
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        eventType: "result",
        eventData: { result: "Task completed successfully." },
      },
    ]);

    const response = await postCallback({
      callbackId,
      runId,
      status: "completed",
      payload: {},
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(runId)).resolves.toBeNull();
  });

  it("returns success without generating summaries for failed callbacks", async () => {
    const fixture = await track(seedFixture());
    const { runId, callbackId } = await seedAgentRun(fixture);

    const response = await postCallback({
      callbackId,
      runId,
      status: "failed",
      error: "Agent run failed",
      payload: {},
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(runId)).resolves.toBeNull();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });
});
