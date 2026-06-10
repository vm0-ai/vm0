import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { createStore } from "ccstate";
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

// BDD migration of the legacy `internal-callbacks-agent.test.ts`.
// The 6 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth + 404
// chain (401 bad signature → 404 no callback record), (2) progress
// + failed chain (200 progress does not mutate the run + no
// axiom query → 200 failed does not generate a summary + no axiom
// query), (3) completed chain (200 completed generates +
// persists a summary when the lightweight model is available →
// 200 completed without OPENROUTER_API_KEY returns success
// without a summary).
//
// Service-Level Exception: post-callback state is verified
// via direct DB reads against `zero_runs.summary` because no
// public GET endpoint exists for the internal callback flow.
// The fixture is seeded via `seedUsageInsightFixture$` +
// `seedCompose$` + `seedRun$` (all Service-Level Exceptions:
// no public route creates these rows in this configuration).

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

const track = createFixtureTracker<AgentCallbackFixture>((fixture) => {
  return deleteFixture(fixture);
});

describe("BDD POST /api/internal/callbacks/agent — auth + 404 chain", () => {
  it("gwt-wt-wt: 401 invalid signature → 404 no callback record", async () => {
    // Given: a fixture + a seeded agent run + callback.
    const fixture = await track(seedFixture());
    const { runId, callbackId } = await seedAgentRun(fixture);

    // When: post with the wrong HMAC secret.
    const badSig = await postCallback(
      { callbackId, runId, status: "completed", payload: {} },
      "wrong-secret",
    );

    // Then: 401.
    expect(badSig.status).toBe(401);

    // Given: a request with the right signature but no
    // matching callback record.
    const missing = await postCallback({
      runId: "00000000-0000-0000-0000-000000000000",
      status: "completed",
      payload: {},
    });

    // When + Then: 404.
    expect(missing.status).toBe(404);
  });
});

describe("BDD POST /api/internal/callbacks/agent — progress + failed chain", () => {
  it("gwt-wt-wt: 200 progress does not mutate the run + no axiom query → 200 failed does not generate a summary + no axiom query", async () => {
    // Given: a fixture + a seeded agent run.
    const fixture = await track(seedFixture());
    const { runId, callbackId } = await seedAgentRun(fixture);

    // When: post a progress callback.
    const progress = await postCallback({
      callbackId,
      runId,
      status: "progress",
      payload: {},
    });

    // Then: 200 + no run summary persisted + no axiom query.
    expect(progress.status).toBe(200);
    await expect(progress.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(runId)).resolves.toBeNull();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();

    // Given: a fresh fixture + a failed callback.
    const failedFx = await track(seedFixture());
    const failedRun = await seedAgentRun(failedFx);

    // When: post a failed callback.
    const failed = await postCallback({
      callbackId: failedRun.callbackId,
      runId: failedRun.runId,
      status: "failed",
      error: "Agent run failed",
      payload: {},
    });

    // Then: 200 + no run summary + no axiom query.
    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(failedRun.runId)).resolves.toBeNull();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });
});

describe("BDD POST /api/internal/callbacks/agent — completed chain", () => {
  it("gwt-wt-wt: 200 completed generates + persists a summary when OpenRouter is available → 200 completed without OPENROUTER_API_KEY returns success without a summary", async () => {
    // Given: a fixture + a seeded agent run + an Axiom
    // result event + a stubbed OpenRouter response.
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

    // When: post a completed callback.
    const completed = await postCallback({
      callbackId,
      runId,
      status: "completed",
      payload: {},
    });

    // Then: 200 + the run summary is persisted.
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(runId)).resolves.toBe("Agent delegated the task.");

    // Given: a fresh fixture + a seeded run + an Axiom
    // result event but no OPENROUTER_API_KEY.
    const noKeyFx = await track(seedFixture());
    const noKeyRun = await seedAgentRun(noKeyFx);
    context.mocks.axiom.query.mockResolvedValueOnce([
      {
        eventType: "result",
        eventData: { result: "Task completed successfully." },
      },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);

    // When: post a completed callback.
    const noKey = await postCallback({
      callbackId: noKeyRun.callbackId,
      runId: noKeyRun.runId,
      status: "completed",
      payload: {},
    });

    // Then: 200 + no run summary.
    expect(noKey.status).toBe(200);
    await expect(noKey.json()).resolves.toStrictEqual({ success: true });
    await expect(runSummary(noKeyRun.runId)).resolves.toBeNull();
  });
});
