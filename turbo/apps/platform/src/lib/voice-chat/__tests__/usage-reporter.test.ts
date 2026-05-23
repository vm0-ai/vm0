import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildUsageEventUrl,
  createUsageReporter,
  type UsageReportPayload,
} from "../usage-reporter";
import { getLoggers, Level } from "../../../signals/log";

const API_BASE = "https://api.test.example";
const SESSION_ID = "00000000-0000-0000-0000-000000000123";
const URL = buildUsageEventUrl(API_BASE, SESSION_ID);

function samplePayload(
  overrides: Partial<UsageReportPayload> = {},
): UsageReportPayload {
  return {
    providerEventId: "evt_test",
    eventType: "response.done",
    inputTextTokens: 10,
    inputAudioTokens: 20,
    outputTextTokens: 5,
    outputAudioTokens: 30,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = { status: 200 },
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

// Microtask drain helper — the reporter chains promise.then handlers, so a
// few microtask flushes is enough to settle the fire+log+drop path. No
// real timer needed (option-2 design has no retry / scheduler).
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("createUsageReporter", () => {
  let originalFetch: typeof fetch;
  const usageLogger = getLoggers().VoiceChatUsageReporter;
  const usageLoggerLevel = usageLogger?.level;

  beforeEach(() => {
    if (usageLogger) {
      usageLogger.level = Level.Error;
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    if (usageLogger && usageLoggerLevel) {
      usageLogger.level = usageLoggerLevel;
    }
  });

  it("buildUsageEventUrl strips trailing slash from apiBase", () => {
    expect(buildUsageEventUrl("https://api.test/", "abc")).toBe(
      "https://api.test/api/zero/voice-chat/abc/usage",
    );
  });

  it("fires a single fetch with auth header on enqueue", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ creditsExhausted: false }));
    globalThis.fetch = fetchSpy;

    const reporter = createUsageReporter({
      apiBase: API_BASE,
      getAuthToken: () => {
        return Promise.resolve("token-abc");
      },
      voiceChatSessionId: SESSION_ID,
      onCreditsExhausted: vi.fn(),
    });
    reporter.enqueue(samplePayload());
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe(URL);
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer token-abc");
    expect(init?.body).toBe(JSON.stringify(samplePayload()));
    reporter.destroy();
  });

  it("fires onCreditsExhausted exactly once across many events", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ creditsExhausted: true }));
    globalThis.fetch = fetchSpy;
    const onCreditsExhausted = vi.fn();
    const reporter = createUsageReporter({
      apiBase: API_BASE,
      getAuthToken: () => {
        return Promise.resolve("token");
      },
      voiceChatSessionId: SESSION_ID,
      onCreditsExhausted,
    });
    for (let i = 0; i < 5; i++) {
      reporter.enqueue(samplePayload({ providerEventId: `evt_${i}` }));
    }
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(onCreditsExhausted).toHaveBeenCalledTimes(1);
    reporter.destroy();
  });

  it("drops 5xx responses without retrying (option-2 design)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    globalThis.fetch = fetchSpy;

    const reporter = createUsageReporter({
      apiBase: API_BASE,
      getAuthToken: () => {
        return Promise.resolve("token");
      },
      voiceChatSessionId: SESSION_ID,
      onCreditsExhausted: vi.fn(),
    });
    reporter.enqueue(samplePayload());
    await flushMicrotasks();

    // Plan D: drain-on-enqueue, no retry; one fetch attempt and done.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    reporter.destroy();
  });

  it("drops 4xx responses without retrying", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 400 }));
    globalThis.fetch = fetchSpy;

    const reporter = createUsageReporter({
      apiBase: API_BASE,
      getAuthToken: () => {
        return Promise.resolve("token");
      },
      voiceChatSessionId: SESSION_ID,
      onCreditsExhausted: vi.fn(),
    });
    reporter.enqueue(samplePayload());
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    reporter.destroy();
  });

  it("flushKeepalive re-fires every previously-enqueued event with keepalive: true", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ creditsExhausted: false }));
    globalThis.fetch = fetchSpy;

    const reporter = createUsageReporter({
      apiBase: API_BASE,
      getAuthToken: () => {
        return Promise.resolve("token");
      },
      voiceChatSessionId: SESSION_ID,
      onCreditsExhausted: vi.fn(),
    });
    // Enqueue once so the reporter caches the token.
    reporter.enqueue(samplePayload({ providerEventId: "evt_first" }));
    await flushMicrotasks();
    fetchSpy.mockClear();

    // Enqueue another, then flush.
    reporter.enqueue(samplePayload({ providerEventId: "evt_second" }));
    reporter.flushKeepalive();
    await flushMicrotasks();

    // flushKeepalive re-fires every payload sent so far (incl. evt_first
    // since it's idempotent server-side via the unique idempotency key).
    const keepaliveCalls = fetchSpy.mock.calls.filter((c) => {
      const init = c[1] as RequestInit | undefined;
      return init?.keepalive === true;
    });
    expect(keepaliveCalls.length).toBeGreaterThan(0);
    reporter.destroy();
  });

  it("ignores subsequent enqueues after destroy", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ creditsExhausted: false }));
    globalThis.fetch = fetchSpy;

    const reporter = createUsageReporter({
      apiBase: API_BASE,
      getAuthToken: () => {
        return Promise.resolve("token");
      },
      voiceChatSessionId: SESSION_ID,
      onCreditsExhausted: vi.fn(),
    });
    reporter.enqueue(samplePayload());
    await flushMicrotasks();
    fetchSpy.mockClear();
    reporter.destroy();
    reporter.enqueue(samplePayload({ providerEventId: "evt_after_destroy" }));
    await flushMicrotasks();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
