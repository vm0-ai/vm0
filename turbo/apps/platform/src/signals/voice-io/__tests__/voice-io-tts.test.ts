import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { playTts$, ttsPlayingMessageId$ } from "../voice-io-tts.ts";

class MockAudio {
  play = (): Promise<void> => {
    return Promise.resolve();
  };
  pause = () => {};
  load = () => {};
  removeAttribute = (_name: string) => {};
  addEventListener = (_type: string, _listener: unknown) => {};
  removeEventListener = (_type: string, _listener: unknown) => {};
}

function mockAudio() {
  const instances: MockAudio[] = [];

  vi.stubGlobal(
    "Audio",
    vi.fn(function (this: MockAudio) {
      Object.assign(this, new MockAudio());
      vi.spyOn(this, "play").mockResolvedValue(undefined);
      instances.push(this);
    }),
  );

  vi.stubGlobal(
    "URL",
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn().mockReturnValue("blob:mock"),
      revokeObjectURL: vi.fn(),
    }),
  );

  return { instances };
}

function mockTtsEndpoint() {
  let fetchCount = 0;

  server.use(
    http.post("http://localhost:3000/api/zero/voice-io/tts", () => {
      fetchCount++;
      const body = new Uint8Array([0]);
      return new HttpResponse(body, {
        headers: { "Content-Type": "audio/mpeg" },
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
    const { instances } = mockAudio();
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
    expect(instances).toHaveLength(1);
  });

  it("should allow playback for a different messageId", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockAudio();
    const { getFetchCount } = mockTtsEndpoint();

    await context.store.set(playTts$, "msg-1", "Hello", context.signal);
    await context.store.set(playTts$, "msg-2", "World", context.signal);

    expect(getFetchCount()).toBe(2);
  });

  it("should reset playingMessageId on fetch failure", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });
    mockAudio();

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
