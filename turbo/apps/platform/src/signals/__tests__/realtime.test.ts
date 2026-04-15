import { describe, it, expect, vi } from "vitest";
import type { RealtimeChannel } from "ably";
import { createStore } from "ccstate";
import { ablyChannelNotify, ablyNotify$ } from "../realtime.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MessageHandler = () => void;

interface MockChannel {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  triggerMessage: () => void;
}

/**
 * Build a minimal mock RealtimeChannel whose subscribe() resolves immediately
 * and whose triggerMessage() fires the registered handler synchronously.
 */
function createMockChannel(): MockChannel {
  const handlers = new Map<string, MessageHandler[]>();

  return {
    subscribe: vi.fn(
      (topic: string, handler: MessageHandler): Promise<void> => {
        const existing = handlers.get(topic) ?? [];
        handlers.set(topic, [...existing, handler]);
        return Promise.resolve();
      },
    ),
    unsubscribe: vi.fn(),
    triggerMessage() {
      for (const handlerList of handlers.values()) {
        for (const h of handlerList) {
          h();
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ablyChannelNotify — Ably subscription logic (no IN_VITEST guard)
// ---------------------------------------------------------------------------

describe("ablyChannelNotify", () => {
  it("calls body once immediately and resolves when body returns true", async () => {
    const channel = createMockChannel();
    const controller = new AbortController();

    const body = vi.fn().mockResolvedValue(true);

    await ablyChannelNotify(
      channel as unknown as RealtimeChannel,
      "invalidate",
      body,
      controller.signal,
    );

    expect(body).toHaveBeenCalledOnce();
    // subscribe should not be called when body resolves true immediately
    expect(channel.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes to the topic and resolves when body returns true on Ably message", async () => {
    const channel = createMockChannel();
    const controller = new AbortController();

    let callCount = 0;
    const body = vi.fn(() => {
      callCount++;
      // False on first call (initial load), true on second (after message)
      return Promise.resolve(callCount >= 2);
    });

    const notifyPromise = ablyChannelNotify(
      channel as unknown as RealtimeChannel,
      "invalidate",
      body,
      controller.signal,
    );

    // Yield so subscribe() promise resolves and the listener is registered
    await Promise.resolve();

    expect(channel.subscribe).toHaveBeenCalledWith(
      "invalidate",
      expect.any(Function),
    );

    // Simulate an Ably push
    channel.triggerMessage();

    await notifyPromise;

    expect(body).toHaveBeenCalledTimes(2);
    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });

  it("calls unsubscribe and rejects when abort fires while waiting", async () => {
    const channel = createMockChannel();
    const controller = new AbortController();

    // body returns false so we enter subscription wait
    const body = vi.fn().mockResolvedValue(false);

    const notifyPromise = ablyChannelNotify(
      channel as unknown as RealtimeChannel,
      "invalidate",
      body,
      controller.signal,
    );

    // Yield so subscribe() promise resolves and abort listener is registered
    await Promise.resolve();

    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    controller.abort(abortError);

    await expect(notifyPromise).rejects.toThrow("aborted");
    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects when subscribe() fails", async () => {
    const failChannel: Partial<RealtimeChannel> = {
      subscribe: vi.fn().mockRejectedValue(new Error("subscribe failed")),
      unsubscribe: vi.fn(),
    };
    const controller = new AbortController();

    const body = vi.fn().mockResolvedValue(false);

    await expect(
      ablyChannelNotify(
        failChannel as unknown as RealtimeChannel,
        "invalidate",
        body,
        controller.signal,
      ),
    ).rejects.toThrow("subscribe failed");
  });

  it("re-invokes body on each Ably message and resolves when done", async () => {
    const channel = createMockChannel();
    const controller = new AbortController();

    let callCount = 0;
    const body = vi.fn(() => {
      callCount++;
      return Promise.resolve(callCount >= 4); // true after 3 messages (1 initial + 3 messages)
    });

    const notifyPromise = ablyChannelNotify(
      channel as unknown as RealtimeChannel,
      "invalidate",
      body,
      controller.signal,
    );

    await Promise.resolve();

    channel.triggerMessage();
    await Promise.resolve();
    channel.triggerMessage();
    await Promise.resolve();
    channel.triggerMessage();

    await notifyPromise;

    // 1 initial + 3 from messages = 4
    expect(body).toHaveBeenCalledTimes(4);
    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects and cleans up when body throws after a message", async () => {
    const channel = createMockChannel();
    const controller = new AbortController();

    let callCount = 0;
    const body = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(false);
      }
      return Promise.reject(new Error("body error"));
    });

    const notifyPromise = ablyChannelNotify(
      channel as unknown as RealtimeChannel,
      "invalidate",
      body,
      controller.signal,
    );

    await Promise.resolve();

    channel.triggerMessage();

    await expect(notifyPromise).rejects.toThrow("body error");
    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });

  it("handles synchronous body returning true on message", async () => {
    const channel = createMockChannel();
    const controller = new AbortController();

    let callCount = 0;
    const body = vi.fn(() => {
      callCount++;
      return callCount >= 2;
    });

    const notifyPromise = ablyChannelNotify(
      channel as unknown as RealtimeChannel,
      "invalidate",
      body,
      controller.signal,
    );

    await Promise.resolve();

    channel.triggerMessage();

    await notifyPromise;

    expect(body).toHaveBeenCalledTimes(2);
    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// ablyNotify$ — IN_VITEST fallback to setLoop
// ---------------------------------------------------------------------------

describe("ablyNotify$ — IN_VITEST fallback (setLoop)", () => {
  it("resolves when body returns true on first call", async () => {
    const store = createStore();
    const ablyNotify = store.get(ablyNotify$);
    const controller = new AbortController();

    const body = vi.fn().mockReturnValue(true);
    await ablyNotify("topic", body, 0, controller.signal);

    expect(body).toHaveBeenCalledOnce();
  });

  it("keeps calling body until it returns true", async () => {
    const store = createStore();
    const ablyNotify = store.get(ablyNotify$);
    const controller = new AbortController();

    let calls = 0;
    const body = vi.fn(() => {
      calls++;
      return calls >= 3;
    });

    await ablyNotify("topic", body, 0, controller.signal);

    expect(body.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
