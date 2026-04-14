import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { playTts$, ttsPlayingMessageId$ } from "../voice-io-tts.ts";

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

  it("should not trigger a second fetch when called twice with the same messageId", async () => {
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

  it("should allow playback for a different messageId", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();
    const { getFetchCount } = mockTtsEndpoint();

    await context.store.set(playTts$, "msg-1", "Hello", context.signal);
    await context.store.set(playTts$, "msg-2", "World", context.signal);

    expect(getFetchCount()).toBe(2);
  });

  it("should reset playingMessageId on fetch failure", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockWebAudio();

    // Allow expected TTS error logs without throwing
    vi.spyOn(console, "error").mockImplementation(() => {});

    server.use(
      http.post("http://localhost:3000/api/zero/voice-io/tts", () => {
        return HttpResponse.json({ error: "fail" }, { status: 500 });
      }),
    );

    await context.store.set(playTts$, "msg-1", "Hello world", context.signal);

    const playingId = context.store.get(ttsPlayingMessageId$);
    expect(playingId).toBeNull();
  });
});
