import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { zeroVoiceChatCandidateContract } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { detach, Reason } from "../../utils.ts";
import {
  startVoiceChatCandidate$,
  endVoiceChatCandidate$,
  vccStatus$,
  vccError$,
  vccSessionId$,
  vccConversationItems$,
  vccTasksById$,
} from "../voice-chat-candidate-session.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    orgId: "org_default",
    userId: "test-user-123",
    agentId: DEFAULT_AGENT_ID,
    mode: "chat" as const,
    status: "active" as const,
    conversationSummary: null,
    workingTasksSummary: null,
    finishedTasksSummary: null,
    summarySeq: 0,
    summaryVersion: 0,
    lastSummaryAt: null,
    createdAt: "2026-04-20T00:00:00Z",
    lastHeartbeatAt: "2026-04-20T00:00:00Z",
    endedAt: null,
    ...overrides,
  };
}

function itemPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    sessionId: SESSION_ID,
    seq: 1,
    role: "user" as const,
    content: "hello",
    taskId: null,
    realtimeItemId: "realtime-1",
    createdAt: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

function taskPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    sessionId: SESSION_ID,
    runId: null,
    callId: "call-1",
    prompt: "do the thing",
    status: "pending" as const,
    assistantMessages: [],
    error: null,
    createdAt: "2026-04-20T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WebRTC stub types
// ---------------------------------------------------------------------------

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
  const calls: unknown[] = [];
  server.use(
    mockApi(
      zeroVoiceChatCandidateContract.createSession,
      ({ body, respond }) => {
        calls.push(body);
        return respond(200, {
          session: sessionPayload(),
          recentTaskLogs: "",
          finishedTasksFullText: "",
          talkerInstructions: "",
          talkerInstructionTokens: 0,
        });
      },
    ),
  );
  return calls;
}

function mockCreateSessionError(
  status: 400 | 401 | 403 = 400,
  message = "nope",
) {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.createSession, ({ respond }) => {
      return respond(status, {
        error: { message, code: "BAD_REQUEST" },
      });
    }),
  );
}

function mockTokenOk() {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.token, ({ respond }) => {
      return respond(200, {
        client_secret: { value: "ek_test", expires_at: 9_999_999_999 },
      });
    }),
  );
}

function mockTokenError() {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.token, ({ respond }) => {
      return respond(500, {
        error: { message: "token failed", code: "INTERNAL_SERVER_ERROR" },
      });
    }),
  );
}

function mockEndSessionOk() {
  const calls: string[] = [];
  server.use(
    mockApi(
      zeroVoiceChatCandidateContract.endSession,
      ({ params, respond }) => {
        calls.push(params.id);
        return respond(200, { ok: true as const });
      },
    ),
  );
  return calls;
}

function mockHeartbeatOk() {
  const calls: string[] = [];
  server.use(
    mockApi(zeroVoiceChatCandidateContract.heartbeat, ({ params, respond }) => {
      calls.push(params.id);
      return respond(200, { ok: true as const });
    }),
  );
  return calls;
}

function mockAppendItemOk() {
  const calls: { role: string; content: string; realtimeItemId: string }[] = [];
  let nextSeq = 10;
  server.use(
    mockApi(zeroVoiceChatCandidateContract.appendItem, ({ body, respond }) => {
      calls.push(body);
      const seq = nextSeq++;
      return respond(200, {
        item: itemPayload({
          id: `${ITEM_ID.slice(0, -2)}${seq.toString().padStart(2, "0")}`,
          seq,
          role: body.role,
          content: body.content,
          realtimeItemId: body.realtimeItemId,
        }),
      });
    }),
  );
  return calls;
}

function mockReadItemsEmpty() {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.readItems, ({ respond }) => {
      return respond(200, { items: [] });
    }),
  );
}

function mockGetSessionOk() {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.getSession, ({ respond }) => {
      return respond(200, {
        session: sessionPayload(),
        recentTaskLogs: "",
        finishedTasksFullText: "",
        talkerInstructions: "",
        talkerInstructionTokens: 0,
      });
    }),
  );
}

function mockListTasksOk() {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.listTasks, ({ respond }) => {
      return respond(200, { tasks: [] });
    }),
  );
}

function mockCreateTaskOk() {
  const calls: { prompt: string; callId: string }[] = [];
  server.use(
    mockApi(zeroVoiceChatCandidateContract.createTask, ({ body, respond }) => {
      calls.push(body);
      return respond(200, {
        task: taskPayload({
          callId: body.callId,
          prompt: body.prompt,
        }),
      });
    }),
  );
  return calls;
}

function mockCreateTaskError() {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.createTask, ({ respond }) => {
      return respond(400, {
        error: { message: "bad task", code: "BAD_REQUEST" },
      });
    }),
  );
}

async function setup() {
  await setupPage({
    context,
    path: "/voice-chat-candidate",
    withoutRender: true,
    featureSwitches: { voiceChat: true },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice-chat-candidate session", () => {
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

  async function startSuccessfully() {
    mockCreateSessionOk();
    mockTokenOk();
    mockReadItemsEmpty();
    mockGetSessionOk();
    mockListTasksOk();
    mockHeartbeatOk();
    detach(
      context.store.set(startVoiceChatCandidate$, undefined, context.signal),
      Reason.DomCallback,
    );
    await vi.waitFor(() => {
      expect(dcRef.current).not.toBeNull();
    });
    dcRef.current?.emitOpen();
    await vi.waitFor(() => {
      expect(context.store.get(vccStatus$)).toBe("connected");
    });
  }

  beforeEach(() => {
    stubWebRTC();
  });

  afterEach(() => {
    clearWebRTC();
  });

  describe("startVoiceChatCandidate$", () => {
    it("transitions to connected on happy path", async () => {
      await setup();
      await startSuccessfully();

      expect(context.store.get(vccSessionId$)).toBe(SESSION_ID);
      expect(context.store.get(vccStatus$)).toBe("connected");

      // First DC send is the session.update with instructions + tools.
      const sent = dcRef.current?.send.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(sent) as {
        type: string;
        session: { tools: { name: string }[] };
      };
      expect(parsed.type).toBe("session.update");
      expect(parsed.session.tools[0]?.name).toBe("create_task");
    });

    it("surfaces create-session error in vccError$", async () => {
      await setup();
      mockCreateSessionError(400, "forbidden");

      await context.store.set(
        startVoiceChatCandidate$,
        undefined,
        context.signal,
      );

      expect(context.store.get(vccStatus$)).toBe("error");
      expect(context.store.get(vccError$)).toBe("forbidden");
    });

    it("surfaces token error in vccError$", async () => {
      await setup();
      mockCreateSessionOk();
      mockTokenError();

      await context.store.set(
        startVoiceChatCandidate$,
        undefined,
        context.signal,
      );

      expect(context.store.get(vccStatus$)).toBe("error");
      expect(context.store.get(vccError$)).toBe("token failed");
    });
  });

  describe("item forwarding", () => {
    it("posts user transcript on input_audio_transcription.completed", async () => {
      await setup();
      const appendCalls = mockAppendItemOk();
      await startSuccessfully();

      dcRef.current?.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt-user-1",
        transcript: "hello world",
      });

      await vi.waitFor(() => {
        expect(appendCalls).toHaveLength(1);
      });
      expect(appendCalls[0]).toStrictEqual({
        role: "user",
        content: "hello world",
        realtimeItemId: "rt-user-1",
      });
    });

    it("posts assistant transcript on response.audio_transcript.done", async () => {
      await setup();
      const appendCalls = mockAppendItemOk();
      await startSuccessfully();

      dcRef.current?.emitMessage({
        type: "response.audio_transcript.done",
        response_id: "resp-1",
        item_id: "rt-asst-1",
        transcript: "hi there",
      });

      await vi.waitFor(() => {
        expect(appendCalls).toHaveLength(1);
      });
      expect(appendCalls[0]).toStrictEqual({
        role: "assistant",
        content: "hi there",
        realtimeItemId: "rt-asst-1",
      });
    });

    it("falls back to response_id + length when item_id is missing", async () => {
      await setup();
      const appendCalls = mockAppendItemOk();
      await startSuccessfully();

      dcRef.current?.emitMessage({
        type: "response.audio_transcript.done",
        response_id: "resp-2",
        transcript: "fallback",
      });

      await vi.waitFor(() => {
        expect(appendCalls).toHaveLength(1);
      });
      expect(appendCalls[0]?.realtimeItemId).toBe("resp-2:8");
    });
  });

  describe("create_task tool", () => {
    it("posts /tasks and sends function_call_output with truncated prompt", async () => {
      await setup();
      const taskCalls = mockCreateTaskOk();
      await startSuccessfully();

      // Clear session.update from first DC open
      dcRef.current?.send.mockClear();

      dcRef.current?.emitMessage({
        type: "response.function_call_arguments.done",
        call_id: "call-abc",
        name: "create_task",
        arguments: JSON.stringify({ prompt: "do the laundry" }),
      });

      await vi.waitFor(() => {
        expect(taskCalls).toHaveLength(1);
      });
      expect(taskCalls[0]).toStrictEqual({
        prompt: "do the laundry",
        callId: "call-abc",
      });

      await vi.waitFor(() => {
        expect(dcRef.current?.send.mock.calls.length).toBeGreaterThan(0);
      });
      const sent = dcRef.current?.send.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(sent) as {
        type: string;
        item: { type: string; call_id: string; output: string };
      };
      expect(parsed.type).toBe("conversation.item.create");
      expect(parsed.item.type).toBe("function_call_output");
      expect(parsed.item.call_id).toBe("call-abc");
      expect(parsed.item.output).toContain("queued");

      const tasks = context.store.get(vccTasksById$);
      expect(Object.values(tasks)).toHaveLength(1);
    });

    it("sends error function_call_output when server rejects", async () => {
      await setup();
      mockCreateTaskError();
      await startSuccessfully();

      dcRef.current?.send.mockClear();

      dcRef.current?.emitMessage({
        type: "response.function_call_arguments.done",
        call_id: "call-err",
        name: "create_task",
        arguments: JSON.stringify({ prompt: "oops" }),
      });

      await vi.waitFor(() => {
        expect(dcRef.current?.send.mock.calls.length).toBeGreaterThan(0);
      });
      const sent = dcRef.current?.send.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(sent) as { item: { output: string } };
      expect(parsed.item.output).toMatch(/failed/i);
    });
  });

  describe("ably poke triggers re-fetch", () => {
    it("upserts new items into vccConversationItems$ on ably event", async () => {
      await setup();
      mockCreateSessionOk();
      mockTokenOk();
      mockGetSessionOk();
      mockListTasksOk();
      mockHeartbeatOk();
      let itemsBatch: ReturnType<typeof itemPayload>[] = [];
      server.use(
        mockApi(zeroVoiceChatCandidateContract.readItems, ({ respond }) => {
          const batch = itemsBatch;
          itemsBatch = [];
          return respond(200, { items: batch });
        }),
      );

      detach(
        context.store.set(startVoiceChatCandidate$, undefined, context.signal),
        Reason.DomCallback,
      );
      await vi.waitFor(() => {
        expect(dcRef.current).not.toBeNull();
      });
      dcRef.current?.emitOpen();
      await vi.waitFor(() => {
        expect(context.store.get(vccStatus$)).toBe("connected");
      });

      itemsBatch = [
        itemPayload({
          id: "99999999-9999-4999-8999-999999999999",
          seq: 5,
          role: "assistant",
          content: "from server",
          realtimeItemId: "rt-srv-1",
        }),
      ];
      triggerAblyEvent(`voice-chat-candidate:${SESSION_ID}`);

      await vi.waitFor(() => {
        const items = context.store.get(vccConversationItems$).filter((e) => {
          return e.kind === "server";
        });
        expect(items).toHaveLength(1);
      });
    });
  });

  describe("endVoiceChatCandidate$", () => {
    it("posts /end and resets state to idle", async () => {
      await setup();
      const endCalls = mockEndSessionOk();
      await startSuccessfully();

      context.store.set(endVoiceChatCandidate$);

      await vi.waitFor(() => {
        expect(endCalls).toContain(SESSION_ID);
      });
      expect(context.store.get(vccStatus$)).toBe("idle");
      expect(context.store.get(vccSessionId$)).toBeNull();
    });
  });
});
