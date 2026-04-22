import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import {
  zeroVoiceChatSessionsContract,
  zeroVoiceChatContextContract,
  zeroVoiceChatTasksContract,
  type ContextEvent,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { detach, Reason } from "../../utils.ts";
import { startVoiceChat$, vcStatus$ } from "../voice-chat-session.ts";

const context = testContext();

const SESSION_ID = "vc-inj-session";
const TASK_ID = "task-abc";

function eventRow(
  overrides: Partial<ContextEvent> & { seq: number },
): ContextEvent {
  return {
    id: `evt-${overrides.seq}`,
    source: "system",
    type: "preparation-ready",
    content: null,
    createdAt: "2026-04-22T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WebRTC stubs
// ---------------------------------------------------------------------------

interface FakeDC {
  readyState: "open" | "closed";
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: (event: string, cb: (ev?: unknown) => void) => void;
  emitOpen: () => void;
}

// ---------------------------------------------------------------------------
// Mock endpoint helpers
// ---------------------------------------------------------------------------

function mockCreateSession() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
      return respond(200, {
        session: {
          id: SESSION_ID,
          status: "preparing",
          runId: "run-1",
          createdAt: "2026-04-22T00:00:00Z",
          prepared: false,
        },
      });
    }),
  );
}

function mockToken() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.token, ({ respond }) => {
      return respond(200, {
        client_secret: { value: "ek_test", expires_at: 9_999_999_999 },
      });
    }),
  );
}

function mockActivate() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.activate, ({ params, respond }) => {
      return respond(200, {
        session: { id: params.id, status: "active" },
      });
    }),
  );
}

function mockHeartbeat() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.heartbeat, ({ respond }) => {
      return respond(200, { ok: true as const });
    }),
  );
}

function mockListTasks() {
  server.use(
    mockApi(zeroVoiceChatTasksContract.listTasks, ({ respond }) => {
      return respond(200, { tasks: [] });
    }),
  );
}

/**
 * Dynamic /context handler. Returns any events with `seq > after`. Tests push
 * rows via the returned `add()` — the preparation-ready seed satisfies the
 * preparation gate, later rows flow through startPoll$ and into
 * injectSlowBrainEvents$. `afterValues` records every poll's `after` query
 * param so tests can use `vi.waitFor` to detect that a triggered poll has
 * been consumed (rather than relying on manual delays).
 */
function mockContextEvents(): {
  add: (...events: ContextEvent[]) => void;
  afterValues: number[];
} {
  const events: ContextEvent[] = [
    eventRow({ seq: 1, type: "preparation-ready" }),
  ];
  const afterValues: number[] = [];
  server.use(
    mockApi(zeroVoiceChatContextContract.getEvents, ({ query, respond }) => {
      const after = query.after ?? 0;
      afterValues.push(after);
      return respond(200, {
        events: events.filter((e) => {
          return e.seq > after;
        }),
      });
    }),
  );
  return {
    add: (...rows: ContextEvent[]) => {
      events.push(...rows);
    },
    afterValues,
  };
}

async function setup() {
  await setupPage({
    context,
    path: "/voice-chat",
    withoutRender: true,
    featureSwitches: { voiceChat: true },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice-chat fast-brain injection", () => {
  const dcRef: { current: FakeDC | null } = { current: null };

  function stubWebRTC() {
    const mediaStreamStub = {
      getAudioTracks() {
        return [{ enabled: true }];
      },
      getTracks() {
        return [{ stop: vi.fn() }];
      },
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue(mediaStreamStub) },
      writable: true,
      configurable: true,
    });

    class FakeRTCPeerConnection {
      iceConnectionState = "new";
      addTrack = vi.fn();
      close = vi.fn();
      createOffer = vi.fn().mockResolvedValue({ sdp: "offer-sdp" });
      setLocalDescription = vi.fn().mockResolvedValue(undefined);
      setRemoteDescription = vi.fn().mockResolvedValue(undefined);

      createDataChannel(): FakeDC {
        const openListeners: (() => void)[] = [];
        const messageListeners: ((ev: MessageEvent) => void)[] = [];
        const closeListeners: (() => void)[] = [];

        const dc: FakeDC = {
          readyState: "open",
          send: vi.fn(),
          close: vi.fn(() => {
            dc.readyState = "closed";
            for (const l of closeListeners) {
              l();
            }
          }),
          addEventListener: (event, cb) => {
            if (event === "open") {
              openListeners.push(cb as () => void);
            }
            if (event === "message") {
              messageListeners.push(cb as (ev: MessageEvent) => void);
            }
            if (event === "close") {
              closeListeners.push(cb as () => void);
            }
          },
          emitOpen: () => {
            for (const l of openListeners) {
              l();
            }
          },
        };

        dcRef.current = dc;
        return dc;
      }

      addEventListener() {
        // no-op: tests don't drive track/ice events
      }
    }

    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);

    class FakeAudio {
      autoplay = false;
      srcObject: unknown = null;
      pause = vi.fn();
    }
    vi.stubGlobal("Audio", FakeAudio);

    server.use(
      http.post("https://api.openai.com/v1/realtime", () => {
        return new HttpResponse("answer-sdp", { status: 200 });
      }),
    );
  }

  function clearWebRTC() {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    dcRef.current = null;
    vi.unstubAllGlobals();
  }

  async function startSuccessfully() {
    mockCreateSession();
    mockToken();
    mockActivate();
    mockHeartbeat();
    mockListTasks();

    detach(
      context.store.set(startVoiceChat$, context.signal),
      Reason.DomCallback,
    );

    await vi.waitFor(() => {
      expect(dcRef.current).not.toBeNull();
    });
    dcRef.current?.emitOpen();
    await vi.waitFor(() => {
      expect(context.store.get(vcStatus$)).toBe("connected");
    });
    // Clear the initial session.update send so each test starts with a clean
    // mock.calls ledger.
    dcRef.current?.send.mockClear();
  }

  /** Read every DC send as a parsed JSON object. */
  function decodedSends(): {
    type: string;
    item?: { content?: { text: string }[] };
  }[] {
    return (dcRef.current?.send.mock.calls ?? []).map((call) => {
      return JSON.parse(call[0] as string);
    });
  }

  function injectedTexts(): string[] {
    return decodedSends()
      .filter((m) => {
        return m.type === "conversation.item.create";
      })
      .map((m) => {
        return m.item?.content?.[0]?.text ?? "";
      });
  }

  beforeEach(() => {
    stubWebRTC();
  });

  afterEach(() => {
    clearWebRTC();
  });

  it("injects a task-dispatched event as `[Task dispatched] <prompt>` user message", async () => {
    await setup();
    const ctx = mockContextEvents();
    await startSuccessfully();

    ctx.add(
      eventRow({
        seq: 2,
        type: "task-dispatched",
        content: JSON.stringify({
          taskId: TASK_ID,
          prompt: "check if PR #123 merged",
        }),
      }),
    );
    triggerAblyEvent(`voice:${SESSION_ID}`);

    await vi.waitFor(() => {
      expect(injectedTexts()).toContain(
        "[Task dispatched] check if PR #123 merged",
      );
    });
  });

  it("does NOT send response.cancel or response.create for a task event alone", async () => {
    await setup();
    const ctx = mockContextEvents();
    await startSuccessfully();

    ctx.add(
      eventRow({
        seq: 2,
        type: "task-dispatched",
        content: JSON.stringify({ taskId: TASK_ID, prompt: "do thing" }),
      }),
    );
    triggerAblyEvent(`voice:${SESSION_ID}`);

    await vi.waitFor(() => {
      expect(injectedTexts()).toContain("[Task dispatched] do thing");
    });
    const types = decodedSends().map((m) => {
      return m.type;
    });
    expect(types).not.toContain("response.cancel");
    expect(types).not.toContain("response.create");
  });

  it("mixed directive + task-dispatched sends both injections plus response.create", async () => {
    await setup();
    const ctx = mockContextEvents();
    await startSuccessfully();

    ctx.add(
      eventRow({
        seq: 2,
        source: "slow-brain",
        type: "directive",
        content: "Tell the user you're on it.",
      }),
      eventRow({
        seq: 3,
        type: "task-dispatched",
        content: JSON.stringify({ taskId: TASK_ID, prompt: "check PR" }),
      }),
    );
    triggerAblyEvent(`voice:${SESSION_ID}`);

    await vi.waitFor(() => {
      const texts = injectedTexts();
      expect(texts).toContain(
        "[Slow-brain directive] Tell the user you're on it.",
      );
      expect(texts).toContain("[Task dispatched] check PR");
    });
    const types = decodedSends().map((m) => {
      return m.type;
    });
    expect(types).toContain("response.create");
  });

  it("formats task-completed success as `[Task completed: done] <result>`", async () => {
    await setup();
    const ctx = mockContextEvents();
    await startSuccessfully();

    ctx.add(
      eventRow({
        seq: 2,
        type: "task-completed",
        content: JSON.stringify({
          taskId: TASK_ID,
          status: "done",
          result: "PR #123 merged by @alice",
          error: null,
        }),
      }),
    );
    triggerAblyEvent(`voice:${SESSION_ID}`);

    await vi.waitFor(() => {
      expect(injectedTexts()).toContain(
        "[Task completed: done] PR #123 merged by @alice",
      );
    });
  });

  it("formats task-completed failure using the error field", async () => {
    await setup();
    const ctx = mockContextEvents();
    await startSuccessfully();

    ctx.add(
      eventRow({
        seq: 2,
        type: "task-completed",
        content: JSON.stringify({
          taskId: TASK_ID,
          status: "failed",
          result: null,
          error: "sandbox timeout",
        }),
      }),
    );
    triggerAblyEvent(`voice:${SESSION_ID}`);

    await vi.waitFor(() => {
      expect(injectedTexts()).toContain(
        "[Task completed: failed] sandbox timeout",
      );
    });
  });

  it("does NOT inject other system events (e.g. session-start)", async () => {
    await setup();
    const ctx = mockContextEvents();
    await startSuccessfully();

    ctx.add(
      eventRow({
        seq: 2,
        type: "session-start",
        content: null,
      }),
    );
    const baseline = ctx.afterValues.length;
    triggerAblyEvent(`voice:${SESSION_ID}`);

    // Wait for the poke to drive at least one poll past the baseline, then
    // assert nothing was injected.
    await vi.waitFor(() => {
      expect(ctx.afterValues.length).toBeGreaterThan(baseline);
    });
    expect(injectedTexts()).toStrictEqual([]);
  });

  it("drops silently when task content is malformed JSON", async () => {
    await setup();
    const ctx = mockContextEvents();
    await startSuccessfully();

    ctx.add(
      eventRow({
        seq: 2,
        type: "task-dispatched",
        content: "{not json",
      }),
    );
    const baseline = ctx.afterValues.length;
    triggerAblyEvent(`voice:${SESSION_ID}`);

    await vi.waitFor(() => {
      expect(ctx.afterValues.length).toBeGreaterThan(baseline);
    });
    expect(injectedTexts()).toStrictEqual([]);
  });
});
