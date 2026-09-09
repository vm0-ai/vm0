import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished, beforeEach } from "vitest";
import { testRuntimeStateContract } from "@okouai/api-contracts/contracts/test-runtime-state";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testRuntimeStateRoutes } from "../test-runtime-state";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  auxiliaryResults,
  auxiliaryWarnings,
} from "./helpers/auxiliary-generation";

// Exercise the real ingest/configuration/flush lifecycle, mocking only its SDK.

const context = testContext();
beforeEach(() => {
  context.mocks.axiom.useRealTelemetry.mockReturnValue(true);
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
});
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const secret = "private-provider-payload";

function completion(
  content: unknown = "A usable summary",
  finishReason = "stop",
  usage?: Readonly<Record<string, unknown>>,
) {
  return HttpResponse.json({
    choices: [
      {
        finish_reason: finishReason,
        ...(finishReason === "length"
          ? { native_finish_reason: "MAX_TOKENS" }
          : {}),
        message: { content },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  });
}

const successUsage = Object.freeze({
  prompt_tokens: 640,
  completion_tokens: 118,
  completion_tokens_details: { reasoning_tokens: 96 },
});

// The provider reports usage on a truncated completion too, and the reasoning
// count is the only direct evidence of how the combined budget was spent.
const exhaustedUsage = Object.freeze({
  prompt_tokens: 640,
  completion_tokens: 2048,
  completion_tokens_details: { reasoning_tokens: 2041 },
});

function responseFailure(code?: string) {
  return HttpResponse.json({
    choices: [
      {
        finish_reason: "error",
        error: { metadata: { error_type: code }, message: secret },
      },
    ],
  });
}

function brokenBody(error: Error) {
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
  );
}

function saveRunSummaryRequest(signal: AbortSignal) {
  // Infrastructure-only exception: a public callback acknowledges before its
  // background work finishes and cannot inject an independently owned task
  // AbortSignal. The existing runtime harness lets cancellation and the real
  // persistence attempt reach the summary boundary. Normal output and fallback
  // cases below use the production chat API and readback instead.
  return setupApp({
    context,
    routes: testRuntimeStateRoutes,
    signal,
    rethrowErrors: true,
  })(testRuntimeStateContract).action({
    body: {
      action: "save-run-summary",
      run_id: randomUUID(),
      trigger_source: "web",
      prompt: secret,
      result_text: secret,
    },
  });
}

async function prepareChatTitle() {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, { displayName: "Outcome title" });
  let threadId: string | undefined;
  return {
    create: async () => {
      const sent = await accept(
        chat.requestSendEvent(
          actor,
          {
            agentId: agent.agentId,
            prompt: secret,
            model: "claude-sonnet-5",
          },
          [201],
        ),
        [201],
      );
      threadId = sent.body.threadId;
    },
    read: async () => {
      const events = await accept(
        chat.requestThreadEvents(actor, {}, [200]),
        [200],
      );
      return events.body.events.flatMap((event) => {
        return event.chatThreadId === threadId && event.kind === "renamed"
          ? [event.title]
          : [];
      });
    },
  };
}

const cases = Object.freeze([
  {
    name: "rate limit wrapped in synthetic 502",
    response: () => {
      return responseFailure("rate_limit_exceeded");
    },
    outcome: "degraded",
    reason: "rate_limited",
  },
  {
    name: "response error code",
    response: () => {
      return HttpResponse.json({
        error: { code: "rate_limit_exceeded", message: secret },
      });
    },
    outcome: "degraded",
    reason: "rate_limited",
  },
  {
    name: "typed response rate limit",
    response: () => {
      return HttpResponse.json({ error: { code: 429, message: secret } });
    },
    outcome: "degraded",
    reason: "rate_limited",
  },
  {
    name: "wrapped invalid parameter overrides transient HTTP",
    response: () => {
      return HttpResponse.json(
        {
          error: {
            metadata: {
              raw: JSON.stringify({
                error: { status: "INVALID_ARGUMENT", message: secret },
              }),
            },
          },
        },
        { status: 503 },
      );
    },
    outcome: "error",
    reason: "invalid_request",
  },
  {
    name: "TLS configuration failure",
    response: () => {
      return brokenBody(
        new TypeError("fetch failed", {
          cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
        }),
      );
    },
    outcome: "error",
    reason: "unknown",
  },
  {
    name: "HTTP rate limit",
    response: () => {
      return new HttpResponse(secret, { status: 429 });
    },
    outcome: "degraded",
    reason: "rate_limited",
  },
  {
    name: "HTTP bad gateway",
    response: () => {
      return new HttpResponse(secret, { status: 502 });
    },
    outcome: "degraded",
    reason: "provider_unavailable",
  },
  {
    name: "HTTP unavailable",
    response: () => {
      return new HttpResponse(secret, { status: 503 });
    },
    outcome: "degraded",
    reason: "provider_unavailable",
  },
  {
    name: "HTTP gateway timeout",
    response: () => {
      return new HttpResponse(secret, { status: 504 });
    },
    outcome: "degraded",
    reason: "upstream_timeout",
  },
  {
    name: "transport failure",
    response: () => {
      return HttpResponse.error();
    },
    outcome: "degraded",
    reason: "network",
  },
  {
    name: "typed transport timeout",
    response: () => {
      return brokenBody(
        new TypeError("terminated", {
          cause: { code: "UND_ERR_BODY_TIMEOUT" },
        }),
      );
    },
    outcome: "degraded",
    reason: "upstream_timeout",
  },
  {
    name: "unproven TimeoutError",
    response: () => {
      return brokenBody(new DOMException(secret, "TimeoutError"));
    },
    outcome: "error",
    reason: "unknown",
  },
  {
    name: "unrelated TypeError",
    response: () => {
      return brokenBody(
        new TypeError(`${secret}\n at /src/signals/${secret}.ts:1:2`),
      );
    },
    outcome: "error",
    reason: "unknown",
  },
  {
    name: "broken credentials",
    response: () => {
      return new HttpResponse(secret, { status: 401 });
    },
    outcome: "error",
    reason: "auth",
  },
  {
    name: "invalid request",
    response: () => {
      return new HttpResponse(secret, { status: 400 });
    },
    outcome: "error",
    reason: "invalid_request",
  },
  {
    name: "unknown synthetic 502",
    response: () => {
      return responseFailure("private_identifier");
    },
    outcome: "error",
    reason: "unknown",
  },
  {
    name: "malformed JSON",
    response: () => {
      return new HttpResponse(secret);
    },
    outcome: "error",
    reason: "invalid_output",
  },
  {
    name: "missing choices",
    response: () => {
      return HttpResponse.json({});
    },
    outcome: "error",
    reason: "invalid_output",
  },
  {
    name: "incompatible content",
    response: () => {
      return completion({ text: secret });
    },
    outcome: "error",
    reason: "invalid_output",
  },
  {
    name: "token budget exhausted with partial text",
    response: () => {
      return completion(secret, "length");
    },
    outcome: "degraded",
    reason: "output_truncated",
  },
  {
    name: "token budget exhausted with empty text",
    response: () => {
      return completion("", "length");
    },
    outcome: "degraded",
    reason: "output_truncated",
  },
  {
    name: "tool terminal outcome",
    response: () => {
      return completion(secret, "tool_calls");
    },
    outcome: "degraded",
    reason: "unexpected_tool_calls",
  },
  {
    name: "content filtered outcome",
    response: () => {
      return completion(secret, "content_filter");
    },
    outcome: "error",
    reason: "invalid_output",
  },
  {
    name: "empty interpreted output",
    response: () => {
      return completion("---");
    },
    outcome: "error",
    reason: "unusable_output",
  },
  {
    name: "success",
    response: () => {
      return completion();
    },
    outcome: "success",
    reason: "none",
  },
]);

describe("auxiliary generation outcomes", () => {
  it.each(cases)(
    "records one bounded outcome for $name",
    async ({ response, outcome, reason }) => {
      const title = await prepareChatTitle();
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      createChatCallbacksApi(context).mockOpenRouterCompletions((body) => {
        return body.messages[0]?.content.includes(
          "Generate a short, descriptive title",
        )
          ? response()
          : "Thinking";
      });
      await title.create();
      await flushWaitUntilForTest();
      await expect(title.read()).resolves.toStrictEqual(
        outcome === "success" ? ["A usable summary"] : [],
      );
      expect(auxiliaryResults(context)).toStrictEqual([
        expect.objectContaining({
          feature: "chat_title",
          outcome,
          reason,
        }),
      ]);
      expect(auxiliaryWarnings(context)).toHaveLength(
        outcome === "error" ? 1 : 0,
      );
      expect(JSON.stringify(auxiliaryWarnings(context))).not.toContain(secret);
      expect(JSON.stringify(auxiliaryResults(context))).not.toContain(secret);
      expect(
        context.mocks.axiomLogging.warn.mock.calls.map(([message]) => {
          return message;
        }),
      ).toStrictEqual(
        outcome === "error" ? ["Auxiliary generation failed"] : [],
      );
      expect(context.mocks.axiomLogging.error.mock.calls).toStrictEqual([]);
    },
  );

  it.each([
    {
      name: "success",
      response: () => {
        return completion("A usable summary", "stop", successUsage);
      },
      expected: {
        outcome: "success",
        reason: "none",
        completion_tokens: 118,
        reasoning_tokens: 96,
      },
    },
    {
      name: "an exhausted token budget",
      response: () => {
        return completion(secret, "length", exhaustedUsage);
      },
      expected: {
        outcome: "degraded",
        reason: "output_truncated",
        completion_tokens: 2048,
        reasoning_tokens: 2041,
      },
    },
  ])(
    "records provider token counts on $name",
    async ({ response, expected }) => {
      const title = await prepareChatTitle();
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      createChatCallbacksApi(context).mockOpenRouterCompletions((body) => {
        return body.messages[0]?.content.includes(
          "Generate a short, descriptive title",
        )
          ? response()
          : "Thinking";
      });
      await title.create();
      await flushWaitUntilForTest();
      expect(auxiliaryResults(context)).toStrictEqual([
        expect.objectContaining({ feature: "chat_title", ...expected }),
      ]);
      expect(auxiliaryWarnings(context)).toStrictEqual([]);
    },
  );

  it("keeps shortened summary text for a caller that can use it", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    server.use(
      http.post(endpoint, () => {
        // PostgreSQL rejects NUL in text, so a persistence attempt is
        // observable. A rejected generation returns nothing and never writes,
        // which makes the storage warning the proof the text was accepted.
        return completion("Unstorable\u0000summary", "length", exhaustedUsage);
      }),
    );
    await saveRunSummaryRequest(context.signal);
    await flushWaitUntilForTest();
    expect(
      context.mocks.axiomLogging.warn.mock.calls.map(([message]) => {
        return message;
      }),
    ).toStrictEqual(["Failed to save run summary"]);
    expect(auxiliaryWarnings(context)).toStrictEqual([]);
    expect(auxiliaryResults(context)).toStrictEqual([
      expect.objectContaining({
        feature: "run_summary",
        outcome: "degraded",
        reason: "output_truncated",
        completion_tokens: 2048,
        reasoning_tokens: 2041,
      }),
    ]);
  });

  it("skips optional title generation when configuration is missing", async () => {
    const title = await prepareChatTitle();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    await title.create();
    await flushWaitUntilForTest();
    await expect(title.read()).resolves.toStrictEqual([]);
    // The title scheduler checks configuration before starting auxiliary work.
    expect(auxiliaryResults(context)).toStrictEqual([]);
    expect(context.mocks.axiomLogging.warn.mock.calls).toStrictEqual([]);
  });

  it.each([
    "missing",
    "sync-ingest",
    "sync-flush",
    "async-flush",
    "abort-ingest",
  ])("keeps generation successful with %s telemetry", async (mode) => {
    const title = await prepareChatTitle();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    server.use(
      http.post(endpoint, () => {
        return completion();
      }),
    );
    if (mode === "missing") {
      mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", undefined);
    } else if (mode === "sync-ingest" || mode === "abort-ingest") {
      context.mocks.axiom.sdkIngest.mockImplementation((_dataset, events) => {
        if (JSON.stringify(events).includes("auxiliary_generation_result")) {
          throw mode === "abort-ingest"
            ? new DOMException("telemetry abort", "AbortError")
            : new Error("ingest unavailable");
        }
      });
    } else if (mode === "sync-flush") {
      context.mocks.axiom.flush.mockImplementation(() => {
        throw new Error("flush unavailable");
      });
    } else {
      context.mocks.axiom.flush.mockRejectedValue(
        new Error("flush unavailable"),
      );
    }
    await title.create();
    await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
    await expect(title.read()).resolves.toStrictEqual(["A usable summary"]);
    expect(auxiliaryWarnings(context)).toStrictEqual([]);
    if (mode === "missing") {
      expect(auxiliaryResults(context)).toStrictEqual([]);
    }
  });

  it.each([
    new DOMException("Caller cancelled", "AbortError"),
    new DOMException("Caller deadline", "TimeoutError"),
  ])(
    "propagates caller cancellation and records it once ($name)",
    async (reason) => {
      const controller = new AbortController();
      onTestFinished(() => {
        return controller.abort();
      });
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      server.use(
        http.post(endpoint, async () => {
          entered.resolve(undefined);
          await release.promise;
          return completion();
        }),
      );
      const request = saveRunSummaryRequest(controller.signal);
      const outcome = (async () => {
        await expect(request).rejects.toBe(reason);
      })();
      await entered.promise;
      controller.abort(reason);
      release.resolve(undefined);
      await outcome;
      await flushWaitUntilForTest();
      expect(auxiliaryResults(context)).toStrictEqual([
        expect.objectContaining({
          outcome: "cancelled",
          reason: "caller_cancelled",
        }),
      ]);
      expect(context.mocks.axiomLogging.warn.mock.calls).toStrictEqual([]);
    },
  );

  it("diagnoses an unrelated body error even when the caller aborts before its rejection settles", async () => {
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    const bodyReady = createDeferredPromise<
      ReadableStreamDefaultController<Uint8Array>
    >(context.signal);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    server.use(
      http.post(endpoint, () => {
        return new HttpResponse(
          new ReadableStream<Uint8Array>(
            {
              pull(body) {
                bodyReady.resolve(body);
              },
            },
            { highWaterMark: 0 },
          ),
        );
      }),
    );
    const request = saveRunSummaryRequest(controller.signal);
    const rejected = (async () => {
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
    })();
    const body = await bodyReady.promise;
    body.error(new TypeError("Unrelated programming failure"));
    controller.abort();
    await rejected;
    await flushWaitUntilForTest();
    expect(auxiliaryResults(context)).toStrictEqual([
      expect.objectContaining({ outcome: "error", reason: "unknown" }),
    ]);
    expect(auxiliaryWarnings(context)).toHaveLength(1);
  });

  it("flushes a background title that finishes after the response through the request lifetime", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const callbacks = createChatCallbacksApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, { displayName: "Late title" });
    const titleEntered = createDeferredPromise<void>(context.signal);
    const releaseTitle = createDeferredPromise<void>(context.signal);
    const flushEntered = createDeferredPromise<void>(context.signal);
    const releaseFlush = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseTitle.settled()) {
        releaseTitle.resolve(undefined);
      }
      if (!releaseFlush.settled()) {
        releaseFlush.resolve(undefined);
      }
    });
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    callbacks.mockOpenRouterCompletions(async (body) => {
      if (
        body.messages[0]?.content.includes(
          "Generate a short, descriptive title",
        )
      ) {
        titleEntered.resolve(undefined);
        await releaseTitle.promise;
        return "Late generated title";
      }
      return "Thinking";
    });
    const beforeSendFlushes = context.mocks.axiom.flush.mock.calls.length;
    const response = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Generate a title",
        model: "claude-sonnet-5",
      },
      [201],
    );
    await titleEntered.promise;
    if (response.status !== 201) {
      throw new Error("Expected an accepted chat event");
    }
    expect(auxiliaryResults(context)).toStrictEqual([]);
    expect(context.mocks.axiom.flush.mock.calls.length).toBeGreaterThan(
      beforeSendFlushes,
    );
    // The response has already scheduled its ordinary flush. Hold only the
    // flush initiated by the late generation and observe the lifecycle drain.
    context.mocks.axiom.flush.mockImplementation(async () => {
      if (!flushEntered.settled()) {
        flushEntered.resolve(undefined);
      }
      await releaseFlush.promise;
    });
    releaseTitle.resolve(undefined);
    let drained = false;
    const drain = (async () => {
      await flushWaitUntilForTest();
      drained = true;
    })();
    await flushEntered.promise;
    expect(drained).toBeFalsy();
    releaseFlush.resolve(undefined);
    await drain;
    expect(drained).toBeTruthy();
    expect(auxiliaryResults(context)).toStrictEqual([
      expect.objectContaining({ feature: "chat_title", outcome: "success" }),
    ]);
    const events = await chat.requestThreadEvents(actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected the thread event list");
    }
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        chatThreadId: response.body.threadId,
        kind: "renamed",
        title: "Late generated title",
      }),
    );
    if (response.status === 201 && response.body.runId) {
      await runs.requestCancelRun(actor, response.body.runId, [200]);
    }
  });

  it("measures interpretation and bounds duration when the clock moves backwards", async () => {
    const title = await prepareChatTitle();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    mockNow(1000);
    server.use(
      http.post(endpoint, () => {
        mockNow(900);
        return completion();
      }),
    );
    await title.create();
    await flushWaitUntilForTest();
    expect(auxiliaryResults(context)).toStrictEqual([
      expect.objectContaining({ outcome: "success", duration_ms: 0 }),
    ]);
  });
});
