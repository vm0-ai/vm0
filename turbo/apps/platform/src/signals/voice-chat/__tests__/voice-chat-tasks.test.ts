import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import {
  zeroVoiceChatContextContract,
  zeroVoiceChatSessionsContract,
  zeroVoiceChatTasksContract,
  type ContextEvent,
  type VoiceChatTask,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { detach, Reason } from "../../utils.ts";
import {
  startVoiceChat$,
  endVoiceChat$,
  vcStatus$,
  vcTasksById$,
  vcActiveTasks$,
  vcAllTasksSorted$,
} from "../voice-chat-session.ts";

const context = testContext();

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function sessionCreatedPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    status: "preparing",
    runId: "99999999-9999-4999-8999-999999999999",
    createdAt: "2026-04-20T00:00:00Z",
    prepared: false,
    ...overrides,
  };
}

function taskPayload(overrides: Partial<VoiceChatTask> = {}): VoiceChatTask {
  return {
    id: TASK_ID_A,
    sessionId: SESSION_ID,
    runId: null,
    prompt: "do the thing",
    status: "running",
    result: null,
    error: null,
    assistantMessages: [],
    createdAt: "2026-04-20T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function prepReadyEvent(seq = 1): ContextEvent {
  return {
    id: `evt-${seq}`,
    seq,
    source: "system",
    type: "preparation-ready",
    content: null,
    createdAt: "2026-04-20T00:00:00Z",
  };
}

type OpenAIRealtimeEvent = { type: string; [key: string]: unknown };

interface FakeDC {
  readyState: "open" | "closed";
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: (event: string, cb: (ev?: unknown) => void) => void;
  emitOpen: () => void;
  emitMessage: (event: OpenAIRealtimeEvent) => void;
  emitClose: () => void;
}

// ---------------------------------------------------------------------------
// Mock endpoint helpers
// ---------------------------------------------------------------------------

function mockCreateSessionOk() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
      return respond(200, { session: sessionCreatedPayload() });
    }),
  );
}

function mockActivateOk() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.activate, ({ respond }) => {
      return respond(200, {
        session: { id: SESSION_ID, status: "active" },
      });
    }),
  );
}

function mockTokenOk() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.token, ({ respond }) => {
      return respond(200, {
        client_secret: { value: "ek_test", expires_at: 9_999_999_999 },
      });
    }),
  );
}

function mockHeartbeatOk() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.heartbeat, ({ respond }) => {
      return respond(200, { ok: true as const });
    }),
  );
}

function mockEndSessionOk() {
  server.use(
    mockApi(zeroVoiceChatSessionsContract.end, ({ respond }) => {
      return respond(200, { ok: true as const });
    }),
  );
}

function mockGetEventsPreparationReady() {
  let delivered = false;
  server.use(
    mockApi(zeroVoiceChatContextContract.getEvents, ({ respond }) => {
      if (delivered) {
        return respond(200, { events: [] });
      }
      delivered = true;
      return respond(200, { events: [prepReadyEvent()] });
    }),
  );
}

function mockAppendEventOk() {
  server.use(
    mockApi(zeroVoiceChatContextContract.appendEvent, ({ body, respond }) => {
      return respond(200, {
        event: {
          id: "evt-append",
          seq: 9999,
          source: body.source,
          type: body.type,
          content: body.content ?? null,
          createdAt: "2026-04-20T00:00:00Z",
        },
      });
    }),
  );
}

interface TasksMockHandle {
  setTasks(tasks: VoiceChatTask[]): void;
  callCount: () => number;
}

function mockListTasksStateful(initial: VoiceChatTask[] = []): TasksMockHandle {
  let current = initial;
  let calls = 0;
  server.use(
    mockApi(zeroVoiceChatTasksContract.listTasks, ({ respond }) => {
      calls++;
      return respond(200, { tasks: current });
    }),
  );
  return {
    setTasks(tasks: VoiceChatTask[]) {
      current = tasks;
    },
    callCount() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// WebRTC stub (mirrors voice-chat-candidate pattern)
// ---------------------------------------------------------------------------

async function setup() {
  await setupPage({
    context,
    path: "/voice-chat",
    withoutRender: true,
    featureSwitches: { voiceChat: true },
  });
}

describe("voice-chat session tasks signals", () => {
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
      private trackListeners: ((ev: unknown) => void)[] = [];
      private iceListeners: (() => void)[] = [];
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
          emitMessage: (event: OpenAIRealtimeEvent) => {
            for (const l of messageListeners) {
              l({ data: JSON.stringify(event) } as MessageEvent);
            }
          },
          emitClose: () => {
            dc.readyState = "closed";
            for (const l of closeListeners) {
              l();
            }
          },
        };

        dcRef.current = dc;
        return dc;
      }

      addEventListener(event: string, cb: (ev?: unknown) => void) {
        if (event === "track") {
          this.trackListeners.push(cb);
        }
        if (event === "iceconnectionstatechange") {
          this.iceListeners.push(cb as () => void);
        }
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

  async function driveToConnected(tasksMock: TasksMockHandle) {
    mockCreateSessionOk();
    mockGetEventsPreparationReady();
    mockActivateOk();
    mockTokenOk();
    mockHeartbeatOk();
    mockEndSessionOk();
    mockAppendEventOk();
    // tasksMock is already registered by caller via mockListTasksStateful
    void tasksMock;

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
  }

  beforeEach(() => {
    stubWebRTC();
  });

  afterEach(() => {
    clearWebRTC();
  });

  describe("empty", () => {
    it("leaves task signals empty when listTasks returns []", async () => {
      await setup();
      const tasksMock = mockListTasksStateful([]);
      await driveToConnected(tasksMock);

      await vi.waitFor(() => {
        expect(tasksMock.callCount()).toBeGreaterThan(0);
      });

      expect(context.store.get(vcTasksById$)).toStrictEqual({});
      expect(context.store.get(vcAllTasksSorted$)).toStrictEqual([]);
      expect(context.store.get(vcActiveTasks$)).toStrictEqual([]);
    });
  });

  describe("running task visible after dispatch", () => {
    it("upserts running task into all three signals after ably poke", async () => {
      await setup();
      const tasksMock = mockListTasksStateful([]);
      await driveToConnected(tasksMock);

      await vi.waitFor(() => {
        expect(context.store.get(vcTasksById$)).toStrictEqual({});
      });

      const running = taskPayload({
        id: TASK_ID_A,
        status: "running",
        prompt: "deploy the staging env",
        createdAt: "2026-04-21T10:00:00Z",
      });
      tasksMock.setTasks([running]);
      triggerAblyEvent(`voice:${SESSION_ID}`);

      await vi.waitFor(() => {
        expect(context.store.get(vcTasksById$)[TASK_ID_A]).toBeDefined();
      });

      expect(context.store.get(vcTasksById$)[TASK_ID_A]?.status).toBe(
        "running",
      );
      expect(context.store.get(vcAllTasksSorted$)).toHaveLength(1);
      expect(context.store.get(vcActiveTasks$)).toHaveLength(1);
      expect(context.store.get(vcActiveTasks$)[0]?.id).toBe(TASK_ID_A);
    });
  });

  describe("running → done transition", () => {
    it("removes task from active list and preserves result", async () => {
      await setup();
      const running = taskPayload({
        id: TASK_ID_A,
        status: "running",
        prompt: "fetch latest logs",
      });
      const tasksMock = mockListTasksStateful([running]);
      await driveToConnected(tasksMock);

      await vi.waitFor(() => {
        expect(context.store.get(vcTasksById$)[TASK_ID_A]?.status).toBe(
          "running",
        );
      });

      const done = taskPayload({
        id: TASK_ID_A,
        status: "done",
        prompt: "fetch latest logs",
        result: "Here are the logs you asked for.",
        finishedAt: "2026-04-21T10:05:00Z",
      });
      tasksMock.setTasks([done]);
      triggerAblyEvent(`voice:${SESSION_ID}`);

      await vi.waitFor(() => {
        expect(context.store.get(vcTasksById$)[TASK_ID_A]?.status).toBe("done");
      });

      expect(context.store.get(vcActiveTasks$)).toHaveLength(0);
      expect(context.store.get(vcAllTasksSorted$)).toHaveLength(1);
      expect(context.store.get(vcTasksById$)[TASK_ID_A]?.result).toBe(
        "Here are the logs you asked for.",
      );
    });
  });

  describe("running → failed transition", () => {
    it("surfaces error message on failure", async () => {
      await setup();
      const running = taskPayload({
        id: TASK_ID_A,
        status: "running",
        prompt: "run flaky script",
      });
      const tasksMock = mockListTasksStateful([running]);
      await driveToConnected(tasksMock);

      await vi.waitFor(() => {
        expect(context.store.get(vcTasksById$)[TASK_ID_A]?.status).toBe(
          "running",
        );
      });

      const failed = taskPayload({
        id: TASK_ID_A,
        status: "failed",
        prompt: "run flaky script",
        error: "Exit code 127",
        finishedAt: "2026-04-21T10:06:00Z",
      });
      tasksMock.setTasks([failed]);
      triggerAblyEvent(`voice:${SESSION_ID}`);

      await vi.waitFor(() => {
        expect(context.store.get(vcTasksById$)[TASK_ID_A]?.status).toBe(
          "failed",
        );
      });

      expect(context.store.get(vcActiveTasks$)).toHaveLength(0);
      expect(context.store.get(vcTasksById$)[TASK_ID_A]?.error).toBe(
        "Exit code 127",
      );
    });
  });

  describe("newest-first ordering", () => {
    it("sorts vcAllTasksSorted by createdAt descending", async () => {
      await setup();
      const older = taskPayload({
        id: TASK_ID_A,
        prompt: "older task",
        createdAt: "2026-04-21T09:00:00Z",
        status: "done",
      });
      const newer = taskPayload({
        id: TASK_ID_B,
        prompt: "newer task",
        createdAt: "2026-04-21T11:00:00Z",
        status: "done",
      });
      // Register intentionally out of chronological order.
      const tasksMock = mockListTasksStateful([older, newer]);
      await driveToConnected(tasksMock);

      await vi.waitFor(() => {
        expect(context.store.get(vcAllTasksSorted$)).toHaveLength(2);
      });

      const sorted = context.store.get(vcAllTasksSorted$);
      expect(sorted[0]?.id).toBe(TASK_ID_B);
      expect(sorted[1]?.id).toBe(TASK_ID_A);
    });
  });

  describe("end session clears tasks", () => {
    it("resets vcTasksById$ on endVoiceChat$", async () => {
      await setup();
      const running = taskPayload({
        id: TASK_ID_A,
        status: "running",
        prompt: "ongoing work",
      });
      const tasksMock = mockListTasksStateful([running]);
      await driveToConnected(tasksMock);

      await vi.waitFor(() => {
        expect(context.store.get(vcTasksById$)[TASK_ID_A]).toBeDefined();
      });

      context.store.set(endVoiceChat$);

      await vi.waitFor(() => {
        expect(context.store.get(vcStatus$)).toBe("idle");
      });

      expect(context.store.get(vcTasksById$)).toStrictEqual({});
      expect(context.store.get(vcAllTasksSorted$)).toStrictEqual([]);
      expect(context.store.get(vcActiveTasks$)).toStrictEqual([]);
    });
  });
});
