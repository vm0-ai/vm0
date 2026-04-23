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
  vccLastAssistantMessage$,
  vccLastUserMessage$,
  vccTaskFeed$,
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
    result: null,
    resultUpdatedAt: null,
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
  const calls: { noiseReduction?: string }[] = [];
  server.use(
    mockApi(zeroVoiceChatCandidateContract.token, ({ body, respond }) => {
      calls.push({ noiseReduction: body.noiseReduction });
      return respond(200, {
        client_secret: { value: "ek_test", expires_at: 9_999_999_999 },
      });
    }),
  );
  return calls;
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

const TALKER_INSTRUCTIONS = "You are a helpful voice assistant.";

function mockGetSessionOk() {
  server.use(
    mockApi(zeroVoiceChatCandidateContract.getSession, ({ respond }) => {
      return respond(200, {
        session: sessionPayload(),
        recentTaskLogs: "",
        finishedTasksFullText: "",
        talkerInstructions: TALKER_INSTRUCTIONS,
        talkerInstructionTokens: 0,
      });
    }),
  );
}

function mockListActiveTasksOk() {
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
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice-chat-candidate session", () => {
  const dcRef: { current: FakeDC | null } = { current: null };
  const audioRef: {
    current: { pause: ReturnType<typeof vi.fn>; currentTime: number } | null;
  } = { current: null };

  function stubWebRTC(
    devices: Partial<MediaDeviceInfo>[] = [
      { kind: "audiooutput", deviceId: "default" },
      { kind: "audiooutput", deviceId: "bt-headset-1" },
    ],
  ) {
    const mediaStreamStub = {
      getAudioTracks() {
        return [{ enabled: true }];
      },
      getTracks() {
        return [{ stop: vi.fn() }];
      },
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStreamStub),
        enumerateDevices: vi
          .fn()
          .mockResolvedValue(devices as MediaDeviceInfo[]),
      },
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
      currentTime = 0;
      pause = vi.fn();

      constructor() {
        audioRef.current = this;
      }
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
    audioRef.current = null;
    vi.unstubAllGlobals();
  }

  async function startSuccessfully() {
    mockCreateSessionOk();
    mockTokenOk();
    mockGetSessionOk();
    mockListActiveTasksOk();
    detach(
      context.store.set(
        startVoiceChatCandidate$,
        DEFAULT_AGENT_ID,
        context.signal,
      ),
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

      // Session config (tools / VAD / modalities) is preset server-side when
      // minting the ephemeral token; dc.open no longer emits session.update.
      // The Ably loop's baseline tick calls syncTalkerInstructions$ which
      // fetches getSession and pushes the talkerInstructions to the live DC.
      // Assert on the observable instructions value, not the wire-format type.
      await vi.waitFor(() => {
        expect(dcRef.current?.send.mock.calls.length ?? 0).toBeGreaterThan(0);
      });
      const sent = dcRef.current?.send.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(sent) as {
        type: string;
        session: { instructions: string };
      };
      expect(parsed.session.instructions).toBe(TALKER_INSTRUCTIONS);
    });

    it("surfaces create-session error in vccError$", async () => {
      await setup();
      mockCreateSessionError(400, "forbidden");

      await context.store.set(
        startVoiceChatCandidate$,
        DEFAULT_AGENT_ID,
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
        DEFAULT_AGENT_ID,
        context.signal,
      );

      expect(context.store.get(vccStatus$)).toBe("error");
      expect(context.store.get(vccError$)).toBe("token failed");
    });

    it("sends near_field noiseReduction when mobile speakerphone is detected", async () => {
      // Simulate a mobile device with no external audio output (speakerphone).
      // resolveAudioConfig() should return near_field, which must be threaded
      // through to the token request body.
      vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
        "Mozilla/5.0 (Linux; Android 13) Mobile Safari/537.36",
      );
      stubWebRTC([{ kind: "audiooutput", deviceId: "default" }]);

      await setup();
      const tokenCalls = mockTokenOk();
      mockCreateSessionOk();
      mockGetSessionOk();
      mockListActiveTasksOk();

      detach(
        context.store.set(
          startVoiceChatCandidate$,
          DEFAULT_AGENT_ID,
          context.signal,
        ),
        Reason.DomCallback,
      );
      await vi.waitFor(() => {
        expect(tokenCalls).toHaveLength(1);
      });
      expect(tokenCalls[0]?.noiseReduction).toBe("near_field");
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

    it("truncates the current assistant audio when user speech starts", async () => {
      await setup();
      const appendCalls = mockAppendItemOk();
      await startSuccessfully();

      dcRef.current?.send.mockClear();
      if (!audioRef.current) {
        throw new Error("audio not initialized");
      }
      audioRef.current.currentTime = 12.345;

      dcRef.current?.emitMessage({
        type: "conversation.item.created",
        item: {
          id: "rt-asst-live",
          type: "message",
          role: "assistant",
        },
      });

      dcRef.current?.emitMessage({
        type: "response.audio_transcript.delta",
        delta: "hello there",
      });

      audioRef.current.currentTime = 13.579;
      await dcRef.current?.emitMessage({
        type: "input_audio_buffer.speech_started",
      });

      expect(audioRef.current.pause).toHaveBeenCalledTimes(1);
      expect(dcRef.current?.send).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(dcRef.current?.send.mock.calls[0]?.[0] as string),
      ).toStrictEqual({
        type: "conversation.item.truncate",
        item_id: "rt-asst-live",
        content_index: 0,
        audio_end_ms: 1234,
      });
      await vi.waitFor(() => {
        expect(appendCalls).toHaveLength(1);
      });
      expect(appendCalls[0]).toStrictEqual({
        role: "system_note",
        content: JSON.stringify({
          type: "assistant_interrupted",
          assistantRealtimeItemId: "rt-asst-live",
          heardText: "hello there",
          audioEndMs: 1234,
        }),
        realtimeItemId: "truncate:rt-asst-live",
      });
    });
  });

  describe("talker tool calls", () => {
    it("posts /tasks with the raw prompt and echoes function_call_output", async () => {
      await setup();
      const taskCalls = mockCreateTaskOk();
      await startSuccessfully();

      // Reset any DC writes queued during setup so assertions below measure
      // only the tool-call response.
      dcRef.current?.send.mockClear();

      dcRef.current?.emitMessage({
        type: "response.function_call_arguments.done",
        call_id: "call-abc",
        name: "inform_slow_brain",
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
      expect(parsed.item.output).toMatch(/slow brain/i);
    });

    it.each([
      ["feel_confused", "not sure what you want"],
      ["feel_unable", "I don't have the github connector"],
      ["want_to_ask_user", "which repo?"],
      ["want_to_reject", "that seems out of scope"],
      ["want_to_apologize", "sorry I can't do this"],
    ])(
      "routes %s through the same task-creation path with the raw prompt",
      async (toolName, userPrompt) => {
        await setup();
        const taskCalls = mockCreateTaskOk();
        await startSuccessfully();
        dcRef.current?.send.mockClear();

        dcRef.current?.emitMessage({
          type: "response.function_call_arguments.done",
          call_id: `call-${toolName}`,
          name: toolName,
          arguments: JSON.stringify({ prompt: userPrompt }),
        });

        await vi.waitFor(() => {
          expect(taskCalls).toHaveLength(1);
        });
        expect(taskCalls[0]).toStrictEqual({
          prompt: userPrompt,
          callId: `call-${toolName}`,
        });
      },
    );

    it("ignores unknown tool names", async () => {
      await setup();
      const taskCalls = mockCreateTaskOk();
      await startSuccessfully();
      dcRef.current?.send.mockClear();

      dcRef.current?.emitMessage({
        type: "response.function_call_arguments.done",
        call_id: "call-unknown",
        name: "not_a_real_tool",
        arguments: JSON.stringify({ prompt: "hi" }),
      });

      // Let any pending microtasks flush.
      await Promise.resolve();
      expect(taskCalls).toHaveLength(0);
    });

    it("sends error function_call_output when server rejects", async () => {
      await setup();
      mockCreateTaskError();
      await startSuccessfully();

      dcRef.current?.send.mockClear();

      dcRef.current?.emitMessage({
        type: "response.function_call_arguments.done",
        call_id: "call-err",
        name: "inform_slow_brain",
        arguments: JSON.stringify({ prompt: "oops" }),
      });

      await vi.waitFor(() => {
        expect(dcRef.current?.send.mock.calls.length).toBeGreaterThan(0);
      });
      const sent = dcRef.current?.send.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(sent) as { item: { output: string } };
      expect(parsed.item.output).toMatch(/fail/i);
    });
  });

  describe("subtitle local state", () => {
    it("populates vccLastUserMessage$ after a finalized user transcript (and leaves assistant untouched)", async () => {
      await setup();
      mockAppendItemOk();
      await startSuccessfully();

      expect(context.store.get(vccLastUserMessage$)).toBe("");
      expect(context.store.get(vccLastAssistantMessage$)).toBe("");

      dcRef.current?.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt-user-final",
        transcript: "hi there",
      });

      await vi.waitFor(() => {
        expect(context.store.get(vccLastUserMessage$)).toBe("hi there");
      });
      expect(context.store.get(vccLastAssistantMessage$)).toBe("");
    });

    it("populates vccLastAssistantMessage$ after a finalized assistant turn", async () => {
      await setup();
      mockAppendItemOk();
      await startSuccessfully();

      dcRef.current?.emitMessage({
        type: "response.audio_transcript.done",
        response_id: "resp-x",
        item_id: "rt-asst-final",
        transcript: "hello from Talker",
      });

      await vi.waitFor(() => {
        expect(context.store.get(vccLastAssistantMessage$)).toBe(
          "hello from Talker",
        );
      });
      expect(context.store.get(vccLastUserMessage$)).toBe("");
    });

    it("ignores whitespace-only transcripts (guards against mis-fires blanking the line)", async () => {
      await setup();
      mockAppendItemOk();
      await startSuccessfully();

      dcRef.current?.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt-user-first",
        transcript: "first",
      });
      await vi.waitFor(() => {
        expect(context.store.get(vccLastUserMessage$)).toBe("first");
      });

      dcRef.current?.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt-user-blank",
        transcript: "   ",
      });
      // Let any pending microtasks flush; the state should NOT be blanked.
      await Promise.resolve();
      expect(context.store.get(vccLastUserMessage$)).toBe("first");
    });
  });

  describe("ably poke refreshes task state", () => {
    it("re-runs listTasks on ably event and updates vccTaskFeed$", async () => {
      await setup();
      mockCreateSessionOk();
      mockTokenOk();
      mockGetSessionOk();
      let activeTasks: ReturnType<typeof taskPayload>[] = [];
      server.use(
        mockApi(zeroVoiceChatCandidateContract.listTasks, ({ respond }) => {
          return respond(200, { tasks: activeTasks });
        }),
      );

      detach(
        context.store.set(
          startVoiceChatCandidate$,
          DEFAULT_AGENT_ID,
          context.signal,
        ),
        Reason.DomCallback,
      );
      await vi.waitFor(() => {
        expect(dcRef.current).not.toBeNull();
      });
      dcRef.current?.emitOpen();
      await vi.waitFor(() => {
        expect(context.store.get(vccStatus$)).toBe("connected");
      });
      await expect(context.store.get(vccTaskFeed$)).resolves.toHaveLength(0);

      activeTasks = [
        taskPayload({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          callId: "call-new",
          status: "running",
        }),
      ];
      triggerAblyEvent(`voice-chat-candidate:${SESSION_ID}`);

      await vi.waitFor(async () => {
        await expect(context.store.get(vccTaskFeed$)).resolves.toHaveLength(1);
      });
    });
  });

  describe("endVoiceChatCandidate$", () => {
    it("tears down WebRTC and resets state to idle without ending the session", async () => {
      await setup();
      await startSuccessfully();

      context.store.set(endVoiceChatCandidate$);

      await vi.waitFor(() => {
        expect(context.store.get(vccStatus$)).toBe("idle");
      });
      expect(context.store.get(vccSessionId$)).toBeNull();
    });
  });
});
