import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "../../routes/__tests__/helpers/agent-run-callback";
import { createFixtureTracker } from "../../routes/__tests__/helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "../../routes/__tests__/helpers/zero-usage-insight";
import { dispatchRunCallbacks$ } from "../agent-run-callback.service";
import { createZeroRun$ } from "../zero-runs-create.service";

const context = testContext();
const store = createStore();

const AGENT_CALLBACK_URL = "http://localhost:3000/api/internal/callbacks/agent";
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

interface AgentCallbackRunFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

interface OpenRouterRequest {
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
  }[];
}

const trackFixture = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function seedAgentCallbackRun(): Promise<AgentCallbackRunFixture> {
  const fixture = await trackFixture(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId,
      triggerSource: "agent",
      status: "completed",
      prompt: "Summarize the delegated task.",
      lastEventSequence: 0,
    },
    context.signal,
  );
  return { ...fixture, composeId, runId };
}

function mockRunOutput(result: string): void {
  context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
    const apl = typeof args[0] === "string" ? args[0] : "";
    return Promise.resolve(
      apl.includes("agent-run-events")
        ? [{ eventType: "result", eventData: { result } }]
        : [],
    );
  });
}

function captureOpenRouterRequests(summary: string): OpenRouterRequest[] {
  const requests: OpenRouterRequest[] = [];
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  server.use(
    http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
      requests.push((await request.json()) as OpenRouterRequest);
      return HttpResponse.json({
        choices: [{ message: { content: summary } }],
      });
    }),
  );
  return requests;
}

function failIfAgentCallbackRouteIsFetched(): () => number {
  let requests = 0;
  server.use(
    http.post(AGENT_CALLBACK_URL, () => {
      requests += 1;
      return HttpResponse.text("agent callback route should not be fetched", {
        status: 500,
      });
    }),
  );
  return () => {
    return requests;
  };
}

async function readCallback(callbackId: string) {
  const db = store.set(writeDb$);
  const [callback] = await db
    .select({
      url: agentRunCallbacks.url,
      internalKind: agentRunCallbacks.internalKind,
      status: agentRunCallbacks.status,
      attempts: agentRunCallbacks.attempts,
      deliveredAt: agentRunCallbacks.deliveredAt,
      lastError: agentRunCallbacks.lastError,
    })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.id, callbackId))
    .limit(1);
  return callback;
}

async function readSummary(runId: string): Promise<string | null | undefined> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ summary: zeroRuns.summary })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.summary;
}

describe("dispatchRunCallbacks$ agent internal dispatch", () => {
  it("dispatches typed agent callbacks through ccstate without fetching the route", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "agent",
        payload: { triggerAgentId: fixture.composeId },
      },
      context.signal,
    );
    mockRunOutput("Typed callback finished.");
    const openRouterRequests = captureOpenRouterRequests("Typed agent summary");
    const routeRequests = failIfAgentCallbackRouteIsFetched();
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(openRouterRequests).toHaveLength(1);
    expect(openRouterRequests[0]?.messages[1]?.content).toContain(
      "Typed callback finished.",
    );
    await expect(readSummary(fixture.runId)).resolves.toBe(
      "Typed agent summary",
    );
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: null,
      internalKind: "agent",
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
    expect((await readCallback(callbackId))?.deliveredAt).toBeInstanceOf(Date);
  });

  it("dispatches legacy agent callback URLs through the same ccstate path", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        url: AGENT_CALLBACK_URL,
        payload: { triggerAgentId: fixture.composeId },
      },
      context.signal,
    );
    mockRunOutput("Legacy callback finished.");
    const openRouterRequests = captureOpenRouterRequests(
      "Legacy agent summary",
    );
    const routeRequests = failIfAgentCallbackRouteIsFetched();
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(openRouterRequests).toHaveLength(1);
    expect(openRouterRequests[0]?.messages[1]?.content).toContain(
      "Legacy callback finished.",
    );
    await expect(readSummary(fixture.runId)).resolves.toBe(
      "Legacy agent summary",
    );
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: AGENT_CALLBACK_URL,
      internalKind: null,
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("keeps non-completed agent callbacks as no-ops", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "agent",
        payload: { triggerAgentId: fixture.composeId },
      },
      context.signal,
    );
    context.mocks.axiom.query.mockImplementation(() => {
      throw new Error("failed agent callbacks should not query output");
    });
    const openRouterRequests = captureOpenRouterRequests("Unexpected summary");
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      {
        db,
        runId: fixture.runId,
        status: "failed",
        error: "Run failed",
      },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    expect(openRouterRequests).toHaveLength(0);
    await expect(readSummary(fixture.runId)).resolves.toBeNull();
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("creates trigger-agent callback rows with typed internal identity", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const fixture = await trackFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId, agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId: parentRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
        status: "running",
      },
      context.signal,
    );
    const db = store.set(writeDb$);

    const response = await store.set(
      createZeroRun$,
      {
        auth: {
          tokenType: "sandbox",
          userId: fixture.userId,
          orgId: fixture.orgId,
          runId: parentRunId,
        },
        body: {
          agentId,
          modelProvider: "vm0",
          prompt: "Delegate this task.",
        },
        apiStartTime: now(),
      },
      context.signal,
    );

    if (response.status !== 201) {
      throw new Error(
        `Expected createZeroRun$ to create a run, received ${JSON.stringify(
          response.body,
        )}`,
      );
    }
    const callbacks = await db
      .select({
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, response.body.runId));

    expect(callbacks).toStrictEqual([
      {
        url: null,
        internalKind: "agent",
        payload: { triggerAgentId: composeId },
      },
    ]);
  });
});
