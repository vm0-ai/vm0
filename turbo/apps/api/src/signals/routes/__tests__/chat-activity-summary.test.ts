import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createRouteMocks } from "./helpers/route-test";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  flushLogs,
  logger,
  __resetForTest as resetLogs,
} from "../../../lib/log";
import {
  advanceRunActivityClockFixture,
  holdRunActivityFixture,
} from "../../../test-fixtures/run-activity";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const callbacks = createChatCallbacksApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const completionBody = z.object({
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});
const evidenceSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  activity: z.array(
    z.object({
      sequence: z.number(),
      index: z.number(),
      kind: z.string(),
      name: z.string(),
      callId: z.string(),
      excerpt: z.string(),
    }),
  ),
});
type Evidence = z.infer<typeof evidenceSchema>;
type TestRun = { runId: string; threadId: string };

function request(actor: ApiTestUser, run: TestRun) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
    chatThreadActivitySummaryContract,
  ).summarize({
    headers: { authorization: "Bearer clerk-session" },
    params: { id: run.threadId },
    body: { runId: run.runId },
  });
}
async function summarize(actor: ApiTestUser, run: TestRun) {
  return (await accept(request(actor, run), [200])).body;
}
async function enable(actor: ApiTestUser, enabled = true) {
  if (!actor.orgId) {
    throw new Error("Expected organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.ThreadActivitySummary]: enabled },
  );
}
async function fixture(enabled = true, prompt = "Prepare a launch checklist") {
  const actor = bdd.user();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const group = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Activity summary",
    description: "Activity API integration",
    visibility: "private",
  });
  await enable(actor, enabled);
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt,
      clientEventId: randomUUID(),
    },
    [201],
  );
  if (sent.status !== 201 || !sent.body.runId) {
    throw new Error("Expected active run");
  }
  const run = { runId: sent.body.runId, threadId: sent.body.threadId };
  await flushWaitUntilForTest();
  await runs.heartbeatRunner(group);
  const claimed = await runs.claimRunnerJob(run.runId);
  await flushWaitUntilForTest();
  return {
    actor,
    run,
    agentId: agent.agentId,
    sandboxToken: claimed.sandboxToken,
    headers: { authorization: `Bearer ${claimed.sandboxToken}` },
  };
}
function provider(
  reply: (
    input: Evidence,
    index: number,
  ) => string | Response | Promise<string | Response> = () => {
    return "Preparing the launch checklist";
  },
) {
  const inputs: Evidence[] = [];
  mockOptionalEnv("OPENROUTER_API_KEY", "activity-test-key");
  server.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request: upstream }) => {
        const body = completionBody.parse(await upstream.json());
        if (
          !body.messages[0]?.content.startsWith(
            "Write one short, user-visible progress phrase",
          )
        ) {
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Existing opening copy" },
              },
            ],
          });
        }
        expect(body.model).toBe("google/gemini-3.8-flash");
        expect(body.max_tokens).toBe(1024);
        const input = evidenceSchema.parse(
          JSON.parse(body.messages[1]!.content),
        );
        inputs.push(input);
        const output = await reply(input, inputs.length);
        return typeof output === "string"
          ? HttpResponse.json({
              choices: [
                { finish_reason: "stop", message: { content: output } },
              ],
            })
          : output;
      },
    ),
  );
  return inputs;
}
function tool(sequenceNumber: number, command = "inspect launch checklist") {
  return {
    type: "assistant",
    sequenceNumber,
    message: {
      content: [
        {
          type: "tool_use",
          id: `call-${sequenceNumber}`,
          name: "bash",
          input: { command },
        },
      ],
    },
  };
}

async function deliver(
  f: Awaited<ReturnType<typeof fixture>>,
  events: Parameters<typeof webhooks.requestAgentEvents>[0]["events"],
) {
  await webhooks.requestAgentEvents(
    { runId: f.run.runId, events },
    f.headers,
    [200],
  );
  await flushWaitUntilForTest();
}

// Exercise the production logger and both real SDK constructors. Only the
// outbound ingestion HTTP request is captured; no application logger is spied on.
function captureDiagnostics() {
  const eventSchema = z
    .object({
      level: z.string(),
      message: z.string(),
      source: z.literal("api"),
      fields: z.record(z.string(), z.unknown()),
    })
    .passthrough();
  const events: z.infer<typeof eventSchema>[] = [];
  context.mocks.axiomLogging.useRealTransport.mockReturnValue(true);
  mockEnv("AXIOM_TOKEN_TELEMETRY", "xaat-activity-logging-test");
  mockEnv("AXIOM_DATASET_SUFFIX", "dev");
  mockEnv("OKOU_DEBUG", "");
  resetLogs();
  server.use(
    http.post(
      "https://api.axiom.co/v1/datasets/vm0-web-logs-dev/ingest",
      async ({ request: ingestion }) => {
        expect(ingestion.headers.get("content-type")).toBe(
          "application/x-ndjson",
        );
        const body = await ingestion.text();
        const batch = body
          .trim()
          .split("\n")
          .map((line) => {
            return eventSchema.parse(JSON.parse(line));
          });
        events.push(...batch);
        return HttpResponse.json({
          ingested: batch.length,
          failed: 0,
          failures: [],
          processedBytes: body.length,
          blocksCreated: 1,
          walLength: 0,
        });
      },
    ),
  );
  onTestFinished(async () => {
    await flushLogs();
    resetLogs();
  });
  logger("api:unrelated").debug("Unrelated activity transport debug");
  return async () => {
    await flushLogs();
    expect(events).not.toContainEqual(
      expect.objectContaining({ level: "debug" }),
    );
    return events.filter((event) => {
      return (
        event.fields.context === "api:activity-summary" ||
        event.fields.context === "api:run-activity"
      );
    });
  };
}

describe("thread activity summary", () => {
  it("enforces feature availability and ownership before cache or model exposure", async () => {
    const f = await fixture(false);
    const diagnostics = captureDiagnostics();
    const inputs = provider();
    await deliver(f, [tool(0, "must not be captured")]);
    await accept(request(f.actor, f.run), [403]);
    expect(inputs).toHaveLength(0);
    await expect(diagnostics()).resolves.toStrictEqual([]);
    await enable(f.actor);
    const first = await summarize(f.actor, f.run);
    expect(first).toMatchObject({
      status: "fresh",
      phrase: "Preparing the launch checklist",
      sourceSequence: null,
    });
    expect(inputs[0]!.activity).toStrictEqual([]);
    await accept(request(bdd.user({ orgId: f.actor.orgId }), f.run), [404]);
    await accept(
      request({ ...f.actor, orgId: `org_${randomUUID()}` }, f.run),
      [404],
    );
    await accept(request(f.actor, { ...f.run, runId: randomUUID() }), [404]);
    await enable(f.actor, false);
    await accept(request(f.actor, f.run), [403]);
    expect(inputs).toHaveLength(1);
  });

  it("ingests content-free activity records through the default production transport at operation granularity", async () => {
    const f = await fixture(true, "PRIVATE_PROMPT");
    const diagnostics = captureDiagnostics();
    const inputs = provider(() => {
      return "PRIVATE PHRASE";
    });
    const batch = [tool(0, "PRIVATE_ARGUMENT"), tool(1, "PRIVATE_EVIDENCE")];
    await deliver(f, batch);
    expect(inputs).toHaveLength(0);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "fresh",
      phrase: "PRIVATE PHRASE",
    });
    await summarize(f.actor, f.run);
    await deliver(f, batch);
    await deliver(f, [
      { type: "usage", sequenceNumber: 2, usage: { input_tokens: 300 } },
    ]);
    expect(inputs).toHaveLength(1);
    const logs = await diagnostics();
    expect(logs).toStrictEqual([
      expect.objectContaining({
        level: "info",
        message: "Activity snapshot capture",
        fields: {
          context: "api:run-activity",
          runId: f.run.runId,
          outcome: "written",
          eventCount: 2,
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Activity summary attempt",
        fields: { context: "api:activity-summary", runId: f.run.runId },
      }),
      expect.objectContaining({
        level: "info",
        message: "Activity summary completion",
        fields: {
          context: "api:activity-summary",
          runId: f.run.runId,
          outcome: "success",
          durationMs: expect.any(Number),
          cooldownMs: 0,
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Activity summary cache",
        fields: {
          context: "api:activity-summary",
          runId: f.run.runId,
          outcome: "fresh",
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Activity snapshot capture",
        fields: {
          context: "api:run-activity",
          runId: f.run.runId,
          outcome: "unchanged",
          eventCount: 2,
        },
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE");
    await webhooks.requestAgentComplete(
      { runId: f.run.runId, exitCode: 0 },
      f.headers,
      [200],
    );
    await flushWaitUntilForTest();
    await deliver(f, [tool(3, "PRIVATE_TERMINAL_ARGUMENT")]);
    await expect(diagnostics()).resolves.toStrictEqual(logs);
    expect(inputs).toHaveLength(1);
  });

  it("rejects queued and superseded run identities before cached or model output", async () => {
    const f = await fixture();
    const inputs = provider();
    await summarize(f.actor, f.run);
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const queued = await chat.requestSendEvent(
      f.actor,
      { agentId: f.agentId, prompt: "Wait for capacity" },
      [201],
    );
    if (queued.status !== 201 || !queued.body.runId) {
      throw new Error("Expected queued run identity");
    }
    expect(queued.body.status).toBe("queued");
    await expect(
      summarize(f.actor, {
        runId: queued.body.runId,
        threadId: queued.body.threadId,
      }),
    ).resolves.toMatchObject({ status: "ineligible", phrase: null });
    expect(inputs).toHaveLength(1);
    await runs.requestCancelRun(f.actor, queued.body.runId, [200]);
    await runs.requestCancelRun(f.actor, f.run.runId, [200]);
    await webhooks.requestAgentComplete(
      { runId: f.run.runId, exitCode: 1, error: "Run cancelled" },
      f.headers,
      [200],
    );
    await flushWaitUntilForTest();
    const next = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        threadId: f.run.threadId,
        prompt: "Prepare the next checklist",
      },
      [201],
    );
    if (next.status !== 201 || !next.body.runId) {
      throw new Error("Expected replacement run identity");
    }
    await flushWaitUntilForTest();
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "ineligible",
      phrase: null,
    });
    await expect(
      summarize(f.actor, {
        runId: next.body.runId,
        threadId: next.body.threadId,
      }),
    ).resolves.toMatchObject({ status: "fresh", runId: next.body.runId });
    expect(inputs).toHaveLength(2);
  });

  it("captures public tools before results after commentary, without demand generation or history writes", async () => {
    const f = await fixture();
    const inputs = provider();
    await deliver(f, [
      {
        type: "assistant",
        sequenceNumber: 0,
        message: {
          content: [
            { type: "text", text: "I will inspect the launch materials" },
            { type: "thinking", thinking: "PRIVATE_REASONING" },
          ],
        },
      },
      {
        type: "assistant",
        sequenceNumber: 1,
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "search",
              input: { query: "launch checklist", api_key: "PRIVATE_KEY" },
            },
          ],
        },
      },
    ]);
    expect(inputs).toHaveLength(0);
    const before = await chat.listThreadEvents(f.actor, f.run.threadId);
    const first = await summarize(f.actor, f.run);
    expect(first).toMatchObject({
      status: "fresh",
      sourceSequence: 1,
      summarySequence: 1,
    });
    expect(first.sourceRevision).toBe(first.summaryRevision);
    expect(JSON.stringify(inputs)).toContain("launch checklist");
    expect(JSON.stringify(inputs)).toContain("search");
    expect(JSON.stringify(inputs)).not.toContain("PRIVATE_");
    expect(JSON.stringify(inputs)).not.toContain("thinking:initial");
    await expect(summarize(f.actor, f.run)).resolves.toStrictEqual(first);
    const after = await chat.listThreadEvents(f.actor, f.run.threadId);
    expect(after.events).toStrictEqual(before.events);
    expect(inputs).toHaveLength(1);
  });

  it("merges late and concurrent evidence deterministically, bounds payloads, and ignores duplicates and usage", async () => {
    const f = await fixture();
    const inputs = provider();
    await Promise.all([
      deliver(f, [tool(20), tool(19)]),
      deliver(f, [tool(18)]),
    ]);
    const first = await summarize(f.actor, f.run);
    expect(
      inputs[0]!.activity.map((entry) => {
        return entry.sequence;
      }),
    ).toStrictEqual([18, 19, 20]);
    await deliver(f, [
      tool(19),
      { type: "usage", sequenceNumber: 21, usage: { input_tokens: 300 } },
    ]);
    expect((await summarize(f.actor, f.run)).sourceRevision).toBe(
      first.sourceRevision,
    );
    await deliver(f, [tool(17)]);
    const late = await summarize(f.actor, f.run);
    expect(late.sourceRevision).not.toBe(first.sourceRevision);
    expect(late.summaryRevision).toBe(first.summaryRevision);
    expect(inputs).toHaveLength(1);
    // Time passage and expired process leases have no production mutation API.
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    await deliver(
      f,
      Array.from({ length: 30 }, (_, i) => {
        return tool(30 + i, "界".repeat(1000));
      }),
    );
    const bounded = await summarize(f.actor, f.run);
    expect(bounded.status).toBe("fresh");
    const activity = inputs[1]!.activity;
    expect(activity.length).toBeLessThanOrEqual(16);
    expect(
      Buffer.byteLength(JSON.stringify(activity), "utf8"),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(
      activity.every((entry) => {
        return Array.from(entry.excerpt).length <= 700;
      }),
    ).toBeTruthy();
    expect(activity.at(-1)?.sequence).toBe(59);
  });

  it("shares one claim across callers and labels late results with their actual older revision", async () => {
    const f = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<string>(context.signal);
    const inputs = provider(async () => {
      entered.resolve(undefined);
      return await release.promise;
    });
    const first = summarize(f.actor, f.run);
    await entered.promise;
    const concurrent = await Promise.all([
      summarize(f.actor, f.run),
      summarize(f.actor, f.run),
    ]);
    expect(
      concurrent.every((value) => {
        return value.status === "pending" && value.phrase === null;
      }),
    ).toBeTruthy();
    await deliver(f, [tool(0, "new activity while the provider is working")]);
    release.resolve("Preparing the requested checklist");
    const finished = await first;
    expect(finished.summarySequence).toBeNull();
    expect(finished.sourceSequence).toBe(0);
    expect(finished.summaryRevision).not.toBe(finished.sourceRevision);
    expect(inputs).toHaveLength(1);
  });

  it("fences an expired owner's completion after a replacement claim succeeds", async () => {
    const f = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<string>(context.signal);
    provider(async (_input, index) => {
      if (index === 1) {
        entered.resolve(undefined);
        return await release.promise;
      }
      return "Checking the current launch materials";
    });
    const abandoned = summarize(f.actor, f.run);
    await entered.promise;
    // Reproduce an instance paused beyond its lease using only this run's clock.
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    await deliver(f, [tool(0)]);
    const replacement = await summarize(f.actor, f.run);
    release.resolve("Obsolete preparation phrase");
    await expect(abandoned).resolves.toStrictEqual(replacement);
    expect(replacement.phrase).toBe("Checking the current launch materials");
  });

  it("invalidates a cached phrase for a visible steering message without a tool event", async () => {
    const f = await fixture();
    const inputs = provider();
    const first = await summarize(f.actor, f.run);
    await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        threadId: f.run.threadId,
        prompt: "Focus on sales owners",
        clientEventId: randomUUID(),
      },
      [201],
    );
    await flushWaitUntilForTest();
    const current = await summarize(f.actor, f.run);
    expect(current.sourceRevision).toBe(first.sourceRevision);
    const reserved = await runs.reserveRunnerActiveInputs(
      f.sandboxToken,
      f.run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected active input reservation");
    }
    await runs.recordRunnerActiveInputDelivery(
      f.sandboxToken,
      f.run.runId,
      reserved.deliveryId,
    );
    const steered = await summarize(f.actor, f.run);
    expect(steered.sourceRevision).not.toBe(first.sourceRevision);
    expect(steered.summaryRevision).toBe(first.summaryRevision);
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.messages).toContainEqual({
      role: "user",
      content: "Focus on sales owners",
    });
  });

  it.each(["cancel", "complete", "delete"] as const)(
    "discards a completion after %s and never exposes terminal cache",
    async (action) => {
      const f = await fixture();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<string>(context.signal);
      const inputs = provider(async () => {
        entered.resolve(undefined);
        return await release.promise;
      });
      const pending = summarize(f.actor, f.run);
      await entered.promise;
      if (action === "cancel") {
        await runs.requestCancelRun(f.actor, f.run.runId, [200]);
      } else if (action === "complete") {
        await webhooks.requestAgentComplete(
          { runId: f.run.runId, exitCode: 0 },
          f.headers,
          [200],
        );
      } else {
        await chat.deleteThread(f.actor, f.run.threadId);
      }
      release.resolve("This phrase must not revive the run");
      await expect(pending).resolves.toMatchObject({
        status: "ineligible",
        phrase: null,
      });
      if (action !== "delete") {
        await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
          status: "ineligible",
          phrase: null,
        });
      } else {
        await accept(request(f.actor, f.run), [404]);
      }
      expect(inputs).toHaveLength(1);
    },
  );

  it.each(["", "line one\nline two", "**Markdown**"])(
    "cools down malformed output %j without retrying",
    async (output) => {
      const f = await fixture();
      const inputs = provider(() => {
        return output;
      });
      const failed = await summarize(f.actor, f.run);
      expect(failed).toMatchObject({
        status: "cooldown",
        phrase: null,
        summaryRevision: null,
      });
      expect(failed.retryAfterMs).toBeGreaterThan(50_000);
      await summarize(f.actor, f.run);
      expect(inputs).toHaveLength(1);
    },
  );

  it("accepts existing Codex commands and tool results while bounding graphemes", async () => {
    const f = await fixture();
    const inputs = provider(() => {
      return "👨‍👩‍👧‍👦".repeat(80);
    });
    await deliver(f, [
      {
        type: "item.started",
        sequenceNumber: 0,
        item: {
          id: "command-1",
          type: "command_execution",
          command: "inspect launch data",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 1,
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "PRIVATE_REASONING",
        },
      },
      {
        type: "item.completed",
        sequenceNumber: 2,
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          tool: "search",
          arguments: { query: "launch owners" },
        },
      },
      {
        type: "user",
        sequenceNumber: 3,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "mcp-1",
              content: [
                { type: "text", text: "Found launch owners" },
                { type: "image", source: { data: "PRIVATE_IMAGE" } },
              ],
            },
          ],
        },
      },
    ]);
    const summary = await summarize(f.actor, f.run);
    expect(summary.phrase).toBe("👨‍👩‍👧‍👦".repeat(60));
    expect(
      inputs[0]!.activity.map((entry) => {
        return entry.sequence;
      }),
    ).toStrictEqual([0, 2, 3]);
    expect(JSON.stringify(inputs)).not.toContain("PRIVATE_");
    expect(inputs[0]!.activity.at(-1)?.excerpt).toBe("Found launch owners");
  });

  it("rejects unauthenticated requests and client-supplied evidence", async () => {
    const client = setupApp({
      context,
      routes: chatThreadActivitySummaryRoutes,
    })(chatThreadActivitySummaryContract);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await accept(
      client.summarize({
        headers: {},
        params: { id: randomUUID() },
        body: { runId: randomUUID() },
      }),
      [401],
    );
    const f = await fixture();
    const inputs = provider();
    createRouteMocks(context).clerk.session(
      f.actor.userId,
      f.actor.orgId,
      f.actor.orgRole,
    );
    const body = {
      runId: f.run.runId,
      prompt: "Client evidence must not be trusted",
    };
    await accept(
      client.summarize({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: f.run.threadId },
        body,
      }),
      [400],
    );
    expect(inputs).toHaveLength(0);
  });

  it("uses a shared cooldown when the model is unconfigured", async () => {
    const f = await fixture();
    const failed = await summarize(f.actor, f.run);
    expect(failed).toMatchObject({ status: "cooldown", phrase: null });
    const inputs = provider();
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(0);
  });

  it("bounds a hanging provider request and never retries within the request", async () => {
    const f = await fixture();
    const release = createDeferredPromise<string>(context.signal);
    const inputs = provider(async () => {
      return await release.promise;
    });
    const result = await summarize(f.actor, f.run);
    release.resolve("Too late");
    expect(result).toMatchObject({ status: "cooldown", phrase: null });
    expect(result.retryAfterMs).toBeGreaterThan(50_000);
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(1);
  }, 15_000);

  it("keeps eight bounded visible messages including the current task", async () => {
    const prompt = "current task ".repeat(100);
    const f = await fixture(true, prompt);
    const inputs = provider();
    await deliver(
      f,
      Array.from({ length: 10 }, (_, index) => {
        return {
          type: "assistant",
          sequenceNumber: index,
          message: {
            content: [
              {
                type: "text",
                text: `Update ${index}: ` + "context ".repeat(150),
              },
            ],
          },
        };
      }),
    );
    await summarize(f.actor, f.run);
    expect(inputs[0]!.messages).toHaveLength(8);
    expect(inputs[0]!.messages[0]).toStrictEqual({
      role: "user",
      content: prompt.slice(0, 700),
    });
    expect(
      inputs[0]!.messages.every((message) => {
        return Array.from(message.content).length <= 700;
      }),
    ).toBeTruthy();
  });

  it("captures activity and delivers messages independently of Axiom ingestion", async () => {
    const f = await fixture();
    const inputs = provider();
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await deliver(f, [
      tool(0),
      {
        type: "assistant",
        sequenceNumber: 1,
        message: {
          content: [
            { type: "text", text: "Public commentary during the Axiom outage" },
          ],
        },
      },
    ]);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "fresh",
      sourceSequence: 1,
    });
    expect(inputs[0]!.activity[0]?.name).toBe("bash");
    expect(
      JSON.stringify(
        (await chat.listThreadEvents(f.actor, f.run.threadId)).events,
      ),
    ).toContain("Public commentary during the Axiom outage");
  });

  it("honors bounded Retry-After and keeps the last known summary", async () => {
    const f = await fixture();
    const diagnostics = captureDiagnostics();
    const inputs = provider((_input, index) => {
      return index === 1
        ? "Preparing the launch checklist"
        : HttpResponse.json(
            { error: { code: 429, message: "PRIVATE_PROVIDER_BODY" } },
            { status: 429, headers: { "Retry-After": "120" } },
          );
    });
    const first = await summarize(f.actor, f.run);
    await deliver(f, [tool(0)]);
    await advanceRunActivityClockFixture(f.run.runId, 16_000);
    const failed = await summarize(f.actor, f.run);
    expect(failed.phrase).toBe(first.phrase);
    expect(failed.summaryRevision).toBe(first.summaryRevision);
    expect(failed.retryAfterMs).toBeGreaterThan(110_000);
    expect(failed.retryAfterMs).toBeLessThanOrEqual(120_000);
    await summarize(f.actor, f.run);
    expect(inputs).toHaveLength(2);
    const logs = await diagnostics();
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Activity summary completion",
        fields: {
          context: "api:activity-summary",
          runId: f.run.runId,
          outcome: "provider_failure",
          providerStatus: 429,
          durationMs: expect.any(Number),
          cooldownMs: 120_000,
        },
      }),
    );
    expect(
      logs.filter((event) => {
        return event.message === "Activity summary attempt";
      }),
    ).toHaveLength(2);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Activity summary cache",
        fields: {
          context: "api:activity-summary",
          runId: f.run.runId,
          outcome: "cooldown",
        },
      }),
    );
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_PROVIDER_BODY");
  });

  it("keeps normal publication working when snapshot writes fail and excludes expired evidence", async () => {
    const f = await fixture();
    const inputs = provider();
    await summarize(f.actor, f.run);
    const diagnostics = captureDiagnostics();
    // A stalled Postgres writer is an infrastructure condition, not a user API.
    const held = await holdRunActivityFixture(f.run.runId, context.signal);
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    await deliver(f, [
      {
        type: "assistant",
        sequenceNumber: 0,
        message: {
          content: [
            {
              type: "text",
              text: "Normal message survives the optional failure",
            },
          ],
        },
      },
    ]);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "unavailable",
      phrase: null,
    });
    await expect(diagnostics()).resolves.toStrictEqual([
      expect.objectContaining({
        level: "warn",
        message: "Activity snapshot capture",
        fields: {
          context: "api:run-activity",
          runId: f.run.runId,
          outcome: "write_failed",
          eventCount: 1,
        },
      }),
      expect.objectContaining({
        level: "warn",
        message: "Activity summary unavailable",
        fields: {
          context: "api:activity-summary",
          runId: f.run.runId,
          outcome: "storage_failed",
        },
      }),
    ]);
    held.release();
    await held.done;
    const page = await chat.listThreadEvents(f.actor, f.run.threadId);
    expect(JSON.stringify(page.events)).toContain("Normal message survives");
    await summarize(f.actor, f.run);
    await advanceRunActivityClockFixture(f.run.runId, 24 * 60 * 60 * 1000 + 1);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "unavailable",
      phrase: null,
    });
    expect(inputs).toHaveLength(1);
  });
  it("cleans expired snapshots through scoped maintenance even while disabled", async () => {
    const f = await fixture();
    const diagnostics = captureDiagnostics();
    const inputs = provider();
    await deliver(f, [tool(0, "old evidence")]);
    await summarize(f.actor, f.run);
    // Retention time is infrastructure-owned and cannot be advanced via user APIs.
    await advanceRunActivityClockFixture(f.run.runId, 24 * 60 * 60 * 1000 + 1);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "unavailable",
      phrase: null,
    });
    await enable(f.actor, false);
    await accept(
      setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
        testCronCleanupSandboxesStateContract,
      ).cleanup({
        body: {
          runIds: [f.run.runId],
          chatThreadIds: [],
          orgIds: [],
          exportJobIds: [],
        },
      }),
      [200],
    );
    await enable(f.actor);
    await expect(summarize(f.actor, f.run)).resolves.toMatchObject({
      status: "fresh",
      sourceSequence: null,
    });
    expect(inputs[1]!.activity).toStrictEqual([]);
    await expect(diagnostics()).resolves.toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Activity snapshot cleanup",
        fields: {
          context: "api:run-activity",
          outcome: "success",
          removed: 1,
          retentionMs: 86_400_000,
        },
      }),
    );
  });
});
