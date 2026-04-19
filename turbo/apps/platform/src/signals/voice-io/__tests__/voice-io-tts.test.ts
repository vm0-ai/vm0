import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { playTts$, stopTts$, ttsPlayingRunId$ } from "../voice-io-tts.ts";
import { createDeferredPromise, resetSignal } from "../../utils.ts";

function mockWebAudio() {
  const sources: {
    onended: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
  }[] = [];

  const mockAudioContext = {
    currentTime: 0,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    createBuffer: vi.fn(
      (_channels: number, length: number, sampleRate: number) => {
        return {
          getChannelData: vi.fn(() => {
            return new Float32Array(length);
          }),
          duration: length / sampleRate,
        };
      },
    ),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as unknown,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        start: vi.fn(),
        addEventListener: vi.fn(),
      };
      sources.push(source);
      return source;
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      return mockAudioContext;
    }),
  );

  return { mockAudioContext, sources };
}

function mockTtsEndpoint() {
  let fetchCount = 0;

  // raw http override: binary streaming response is out of scope for mockApi (Phase 0 of #9707); full origin URL intentional for fetch interception
  server.use(
    http.post("http://localhost:3000/api/zero/voice-io/tts", () => {
      fetchCount++;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x00, 0x01, 0x00, 0x02]));
          controller.close();
        },
      });
      return new HttpResponse(body, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }),
  );

  return {
    getFetchCount: () => {
      return fetchCount;
    },
  };
}

describe("playTts$", () => {
  const context = testContext();

  it("should not trigger a second fetch when called twice with the same runId", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();
    const { getFetchCount } = mockTtsEndpoint();

    const p1 = context.store.set(
      playTts$,
      "msg-1",
      "Hello world",
      context.signal,
    );
    const p2 = context.store.set(
      playTts$,
      "msg-1",
      "Hello world",
      context.signal,
    );
    await Promise.all([p1, p2]);

    expect(getFetchCount()).toBe(1);
    expect(AudioContext).toHaveBeenCalledTimes(1);
  });

  it("should allow playback for a different runId", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();
    const { getFetchCount } = mockTtsEndpoint();

    await context.store.set(playTts$, "msg-1", "Hello", context.signal);
    await context.store.set(playTts$, "msg-2", "World", context.signal);

    expect(getFetchCount()).toBe(2);
  });

  it("should reset playingRunId on fetch failure", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();

    // Allow expected TTS error logs without throwing
    vi.spyOn(console, "error").mockImplementation(() => {});

    // raw http override: binary streaming response is out of scope for mockApi (Phase 0 of #9707); full origin URL intentional for fetch interception
    server.use(
      http.post("http://localhost:3000/api/zero/voice-io/tts", () => {
        return HttpResponse.json({ error: "fail" }, { status: 500 });
      }),
    );

    await context.store.set(playTts$, "msg-1", "Hello world", context.signal);

    const playingId = context.store.get(ttsPlayingRunId$);
    expect(playingId).toBeNull();
  });

  it("should reset playingRunId after pre-aborted signal", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();
    mockTtsEndpoint();

    await expect(
      context.store.set(playTts$, "msg-1", "Hello world", AbortSignal.abort()),
    ).rejects.toThrow();

    expect(context.store.get(ttsPlayingRunId$)).toBeNull();
  });

  it("should reset playingRunId after signal abort during fetch", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();

    const fetchGate = createDeferredPromise<void>(context.signal);
    // raw http override: binary streaming response is out of scope for mockApi (Phase 0 of #9707); full origin URL intentional for fetch interception
    server.use(
      http.post("http://localhost:3000/api/zero/voice-io/tts", async () => {
        await fetchGate.promise;
        return HttpResponse.json({});
      }),
    );

    const pageReset$ = resetSignal();
    const pageSignal = context.store.set(pageReset$, context.signal);
    const playPromise = context.store.set(
      playTts$,
      "msg-2",
      "Hello world",
      pageSignal,
    );
    // Abort the signal by resetting — simulates page navigation
    context.store.set(pageReset$, context.signal);

    await expect(playPromise).rejects.toThrow();
    expect(context.store.get(ttsPlayingRunId$)).toBeNull();
  });

  it("should allow replaying the same message after a previous abort", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();

    const fetchGate = createDeferredPromise<void>(context.signal);
    // raw http override: binary streaming response is out of scope for mockApi (Phase 0 of #9707); full origin URL intentional for fetch interception
    server.use(
      http.post("http://localhost:3000/api/zero/voice-io/tts", async () => {
        await fetchGate.promise;
        return HttpResponse.json({});
      }),
    );

    // First attempt — abort mid-flight
    const pageReset$ = resetSignal();
    const pageSignal = context.store.set(pageReset$, context.signal);
    const p1 = context.store.set(playTts$, "msg-3", "Hello", pageSignal);
    // Abort the signal by resetting — simulates page navigation
    context.store.set(pageReset$, context.signal);
    try {
      await p1;
    } catch {
      // expected abort
    }

    expect(context.store.get(ttsPlayingRunId$)).toBeNull();

    // Second attempt with fresh signal — must succeed
    const { getFetchCount } = mockTtsEndpoint();
    await context.store.set(playTts$, "msg-3", "Hello", context.signal);
    expect(getFetchCount()).toBe(1);
  });

  it("should allow replaying after stopTts$", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();
    mockTtsEndpoint();

    await context.store.set(playTts$, "msg-4", "Hello world", context.signal);
    context.store.set(stopTts$);
    expect(context.store.get(ttsPlayingRunId$)).toBeNull();

    const { getFetchCount } = mockTtsEndpoint();
    await context.store.set(playTts$, "msg-4", "Hello again", context.signal);
    expect(getFetchCount()).toBe(1);
  });

  it("should invoke cleanup function (reader.cancel + audioCtx.close) when stopTts$ is called", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    const { mockAudioContext } = mockWebAudio();
    mockTtsEndpoint();

    await context.store.set(playTts$, "msg-5", "Hello world", context.signal);

    // AudioContext.close should not have been called during normal playback
    expect(mockAudioContext.close).not.toHaveBeenCalled();

    // stopTts$ triggers the stored cleanup function
    context.store.set(stopTts$);

    // The cleanup function should have called audioCtx.close()
    expect(mockAudioContext.close).toHaveBeenCalledTimes(1);
  });
});
