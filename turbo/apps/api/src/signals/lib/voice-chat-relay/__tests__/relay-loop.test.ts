import { delay } from "signal-timers";
import { describe, expect, it } from "vitest";

import type { ParsedOpenAiEvent } from "../event-types";
import type {
  OpenAiRealtimeClient,
  OpenAiRealtimeClientOptions,
  OutgoingOpenAiEvent,
} from "../openai-realtime-client";
import { createInMemoryRelaySessionRepository } from "../relay-session-repository";
import {
  runRelay,
  type BrowserSocketLike,
  type ProviderEventHandlers,
  type RelayContext,
} from "../relay-loop";

interface FakeBrowser {
  readonly socket: BrowserSocketLike;
  readonly received: () => readonly string[];
  // Drives the loop's onMessage callbacks from the test side.
  readonly emitMessage: (data: string) => void;
  readonly emitClose: () => void;
}

function fakeBrowserSocket(): FakeBrowser {
  let onMessage: ((data: string) => void) | null = null;
  let onClose: ((code: number, reason: string) => void) | null = null;
  const received: string[] = [];
  return {
    socket: {
      send: (data) => {
        received.push(data);
      },
      close: () => {
        if (onClose !== null) {
          onClose(1000, "closed");
        }
      },
      onMessage: (handler) => {
        onMessage = handler;
      },
      onClose: (handler) => {
        onClose = handler;
      },
      // No-op: tests don't drive socket errors. Required by BrowserSocketLike.
      onError: () => {},
    },
    received: () => {
      return received;
    },
    emitMessage: (data) => {
      if (onMessage !== null) {
        onMessage(data);
      }
    },
    emitClose: () => {
      if (onClose !== null) {
        onClose(1000, "browser closed");
      }
    },
  };
}

interface FakeOpenAi {
  readonly client: OpenAiRealtimeClient;
  // Test seam: drive events from the OpenAI side.
  readonly emitEvent: (event: ParsedOpenAiEvent) => void;
  readonly emitClose: (code?: number, reason?: string) => void;
  readonly sentToOpenAi: () => readonly OutgoingOpenAiEvent[];
  readonly resolveOpen: (sessionId: string) => void;
  readonly rejectOpen: (err: Error) => void;
}

function fakeOpenAiClientFactory(): {
  readonly factory: (opts: OpenAiRealtimeClientOptions) => OpenAiRealtimeClient;
  readonly fake: FakeOpenAi;
} {
  let openResolve: ((r: { readonly openaiSessionId: string }) => void) | null =
    null;
  let openReject: ((err: Error) => void) | null = null;
  let eventHandler: ((e: ParsedOpenAiEvent) => void | Promise<void>) | null =
    null;
  let closeHandler: ((code: number, reason: string) => void) | null = null;
  const sent: OutgoingOpenAiEvent[] = [];

  const client: OpenAiRealtimeClient = {
    open: () => {
      return new Promise<{ readonly openaiSessionId: string }>(
        (resolve, reject) => {
          openResolve = resolve;
          openReject = reject;
        },
      );
    },
    send: (event) => {
      sent.push(event);
    },
    onEvent: (handler) => {
      eventHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    onError: () => {},
    close: () => {},
  };

  const fake: FakeOpenAi = {
    client,
    emitEvent: (event) => {
      if (eventHandler !== null) {
        const result = eventHandler(event);
        if (result instanceof Promise) {
          result.catch(() => {
            // Handler errors not relevant to fixture
          });
        }
      }
    },
    emitClose: (code = 1000, reason = "fake closed") => {
      if (closeHandler !== null) {
        closeHandler(code, reason);
      }
    },
    sentToOpenAi: () => {
      return sent;
    },
    resolveOpen: (sessionId) => {
      if (openResolve !== null) {
        openResolve({ openaiSessionId: sessionId });
        openResolve = null;
        openReject = null;
      }
    },
    rejectOpen: (err) => {
      if (openReject !== null) {
        openReject(err);
        openResolve = null;
        openReject = null;
      }
    },
  };

  return {
    factory: () => {
      return client;
    },
    fake,
  };
}

async function tick(): Promise<void> {
  // The relay-loop serializes provider events through a Promise chain; a
  // microtask drain is not enough to settle the chain, so a real
  // (zero-millisecond) macrotask is needed. signal-timers' delay() requires
  // an AbortSignal — these tests don't model abort.
  await delay(0, { signal: new AbortController().signal });
}

describe("runRelay", () => {
  it("creates a relay-session row, transitions starting → active → ended", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const browser = fakeBrowserSocket();
    const oa = fakeOpenAiClientFactory();

    const promise = runRelay({
      browserSocket: browser.socket,
      voiceChatSessionId: "vc_1",
      userId: "user_1",
      orgId: "org_1",
      instructions: "hello",
      signal: new AbortController().signal,
      repo,
      openAiClientFactory: oa.factory,
      openAiApiKey: "sk-test",
    });

    await tick();
    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0]?.status).toBe("starting");

    oa.fake.resolveOpen("openai_1");
    oa.fake.emitEvent({
      kind: "session.created",
      openaiSessionId: "openai_1",
      raw: { type: "session.created", session: { id: "openai_1" } },
    });
    await tick();

    expect(repo.list()[0]?.status).toBe("active");
    expect(repo.list()[0]?.openaiSessionId).toBe("openai_1");

    // Browser observed relay.ready envelope before the raw OpenAI event
    const received = browser.received();
    const envelope = received.map((line) => {
      return JSON.parse(line) as { type: string };
    });
    expect(
      envelope.some((m) => {
        return m.type === "relay.ready";
      }),
    ).toBeTruthy();

    browser.emitClose();
    await tick();
    await promise;
    expect(repo.list()[0]?.status).toBe("ended");
    const lastEnvelope = JSON.parse(received[received.length - 1] ?? "{}") as {
      type: string;
    };
    expect(lastEnvelope.type).toBe("relay.closed");
  });

  it("invokes onProviderEvent for every parsed OpenAI event with stable ctx shape", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const browser = fakeBrowserSocket();
    const oa = fakeOpenAiClientFactory();
    const observed: { kind: string; ctx: RelayContext }[] = [];
    const handlers: ProviderEventHandlers = {
      onProviderEvent: (event, ctx) => {
        observed.push({ kind: event.kind, ctx });
      },
    };

    const promise = runRelay({
      browserSocket: browser.socket,
      voiceChatSessionId: "vc_1",
      userId: "user_1",
      orgId: "org_1",
      instructions: "x",
      signal: new AbortController().signal,
      repo,
      handlers,
      openAiClientFactory: oa.factory,
      openAiApiKey: "sk-test",
    });

    await tick();
    oa.fake.resolveOpen("openai_a");
    oa.fake.emitEvent({
      kind: "session.created",
      openaiSessionId: "openai_a",
      raw: { type: "session.created", session: { id: "openai_a" } },
    });
    oa.fake.emitEvent({
      kind: "passthrough",
      type: "response.audio.delta",
      raw: { type: "response.audio.delta" },
    });
    await tick();

    expect(
      observed.map((o) => {
        return o.kind;
      }),
    ).toStrictEqual(["session.created", "passthrough"]);
    const ctx = observed[0]?.ctx;
    expect(ctx?.relaySessionId).toBe(repo.list()[0]?.id);
    expect(ctx?.voiceChatSessionId).toBe("vc_1");
    expect(ctx?.orgId).toBe("org_1");
    expect(ctx?.userId).toBe("user_1");
    expect(typeof ctx?.sendToOpenAi).toBe("function");
    expect(typeof ctx?.endRelay).toBe("function");

    browser.emitClose();
    await tick();
    await promise;
  });

  it("rejects a forbidden browser event and closes with 4400", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const browser = fakeBrowserSocket();
    const oa = fakeOpenAiClientFactory();

    const promise = runRelay({
      browserSocket: browser.socket,
      voiceChatSessionId: "vc_1",
      userId: "user_1",
      orgId: "org_1",
      instructions: "x",
      signal: new AbortController().signal,
      repo,
      openAiClientFactory: oa.factory,
      openAiApiKey: "sk-test",
    });

    await tick();
    oa.fake.resolveOpen("openai_z");
    oa.fake.emitEvent({
      kind: "session.created",
      openaiSessionId: "openai_z",
      raw: { type: "session.created", session: { id: "openai_z" } },
    });
    await tick();

    browser.emitMessage(JSON.stringify({ type: "session.created" }));
    await tick();

    expect(repo.list()[0]?.status).toBe("error");
    const received = browser.received();
    const last = JSON.parse(received[received.length - 1] ?? "{}") as {
      type: string;
    };
    expect(last.type).toBe("relay.error");

    await promise;
  });

  it("forwards an allow-listed browser event to OpenAI", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const browser = fakeBrowserSocket();
    const oa = fakeOpenAiClientFactory();

    const promise = runRelay({
      browserSocket: browser.socket,
      voiceChatSessionId: "vc_1",
      userId: "user_1",
      orgId: "org_1",
      instructions: "x",
      signal: new AbortController().signal,
      repo,
      openAiClientFactory: oa.factory,
      openAiApiKey: "sk-test",
    });

    await tick();
    oa.fake.resolveOpen("openai_y");
    oa.fake.emitEvent({
      kind: "session.created",
      openaiSessionId: "openai_y",
      raw: { type: "session.created", session: { id: "openai_y" } },
    });
    await tick();

    browser.emitMessage(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: "AAAA",
      }),
    );
    await tick();

    const sent = oa.fake.sentToOpenAi();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(
      sent.some((s) => {
        return s.type === "input_audio_buffer.append";
      }),
    ).toBeTruthy();

    browser.emitClose();
    await tick();
    await promise;
  });

  it("transitions the row to error when OpenAI open fails", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const browser = fakeBrowserSocket();
    const oa = fakeOpenAiClientFactory();

    const promise = runRelay({
      browserSocket: browser.socket,
      voiceChatSessionId: "vc_1",
      userId: "user_1",
      orgId: "org_1",
      instructions: "x",
      signal: new AbortController().signal,
      repo,
      openAiClientFactory: oa.factory,
      openAiApiKey: "sk-test",
    });

    await tick();
    oa.fake.rejectOpen(new Error("connect refused"));
    await promise;

    const row = repo.list()[0];
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("connect refused");
  });

  // Note: structural "does not log raw transcript" coverage was removed —
  // `RelayLogExtras` enforces the no-transcript constraint at the type level,
  // making the runtime assertion redundant. The "uses RelaySessionRepository
  // as a port" test was also removed (tautology — it only verified the test
  // fixture itself).
});
