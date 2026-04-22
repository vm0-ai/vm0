import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import {
  zeroVoiceChatContextContract,
  zeroVoiceChatSessionsContract,
  zeroVoiceChatTasksContract,
  type ContextEvent,
  type VoiceChatTask,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import {
  startVoiceChat$,
  vcStatus$,
  vcTasksById$,
} from "../../../signals/voice-chat/voice-chat-session.ts";

const context = testContext();

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sessionCreatedPayload() {
  return {
    id: SESSION_ID,
    status: "preparing",
    runId: "99999999-9999-4999-8999-999999999999",
    createdAt: "2026-04-20T00:00:00Z",
    prepared: false,
  };
}

function taskPayload(overrides: Partial<VoiceChatTask> = {}): VoiceChatTask {
  return {
    id: TASK_ID,
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

function prepReadyEvent(): ContextEvent {
  return {
    id: "evt-1",
    seq: 1,
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

function mockAllOk(initialTasks: VoiceChatTask[] = []) {
  let eventDelivered = false;

  server.use(
    mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
      return respond(200, { session: sessionCreatedPayload() });
    }),
    mockApi(zeroVoiceChatContextContract.getEvents, ({ respond }) => {
      if (eventDelivered) {
        return respond(200, { events: [] });
      }
      eventDelivered = true;
      return respond(200, { events: [prepReadyEvent()] });
    }),
    mockApi(zeroVoiceChatSessionsContract.activate, ({ respond }) => {
      return respond(200, {
        session: { id: SESSION_ID, status: "active" },
      });
    }),
    mockApi(zeroVoiceChatSessionsContract.token, ({ respond }) => {
      return respond(200, {
        client_secret: { value: "ek_test", expires_at: 9_999_999_999 },
      });
    }),
    mockApi(zeroVoiceChatSessionsContract.heartbeat, ({ respond }) => {
      return respond(200, { ok: true as const });
    }),
    mockApi(zeroVoiceChatSessionsContract.end, ({ respond }) => {
      return respond(200, { ok: true as const });
    }),
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
    mockApi(zeroVoiceChatTasksContract.listTasks, ({ respond }) => {
      return respond(200, { tasks: initialTasks });
    }),
  );
}

describe("tasks panel component", () => {
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

      addEventListener() {
        // no-op for tests
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

  async function startSession() {
    detachedSetupPage({
      context,
      path: "/voice-chat",
      featureSwitches: { voiceChat: true },
    });

    await waitFor(() => {
      const btn = screen.getAllByRole("button").find((b) => {
        return /start voice chat/i.test(b.textContent ?? "");
      });
      expect(btn).toBeDefined();
      expect(btn).not.toBeDisabled();
    });

    detach(
      context.store.set(startVoiceChat$, context.signal),
      Reason.DomCallback,
    );

    await waitFor(() => {
      expect(dcRef.current).not.toBeNull();
    });
    dcRef.current?.emitOpen();

    await waitFor(() => {
      expect(context.store.get(vcStatus$)).toBe("connected");
    });
  }

  beforeEach(() => {
    stubWebRTC();
  });

  afterEach(() => {
    clearWebRTC();
  });

  it("renders empty state when there are no tasks", async () => {
    mockAllOk([]);
    await startSession();

    await waitFor(() => {
      expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/active tasks/i)).toBeInTheDocument();
  });

  it("renders a running task card with spinner and prompt", async () => {
    const running = taskPayload({
      status: "running",
      prompt: "deploy the staging environment",
    });
    mockAllOk([running]);
    await startSession();

    await waitFor(() => {
      expect(context.store.get(vcTasksById$)[TASK_ID]).toBeDefined();
    });

    await expect(
      screen.findByText(/deploy the staging environment/),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    const panel = screen.getByText(/active tasks/i).closest("aside");
    expect(panel?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("renders a done task card with its result body", async () => {
    const done = taskPayload({
      status: "done",
      prompt: "fetch latest logs",
      result: "Here are the logs you asked for.",
      finishedAt: "2026-04-21T10:05:00Z",
    });
    mockAllOk([done]);
    await startSession();

    await waitFor(() => {
      expect(context.store.get(vcTasksById$)[TASK_ID]?.status).toBe("done");
    });

    await expect(
      screen.findByText(/fetch latest logs/),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(
      screen.getByText(/here are the logs you asked for/i),
    ).toBeInTheDocument();
    const panel = screen.getByText(/active tasks/i).closest("aside");
    expect(panel?.querySelector(".animate-spin")).toBeNull();
  });
});
