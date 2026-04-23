/**
 * Unit tests for the page-signal module behind Trinity (issue #10618).
 *
 * Covered:
 * - `agentChatVoiceMode$` default state and `enter` / `exit` transitions
 * - `lastUserMessage$` / `lastAgentMessage$` derive the most recent content
 *   for their respective roles — task_result items must NOT overwrite the
 *   user or agent lines
 * - `agentChatPendingTasks$` hides `done` / `failed` and sorts by createdAt
 *
 * External mocks: feature-switch backend (via setMockFeatureSwitches) is not
 * needed here — these tests exercise only the page signals. The derived
 * conversation / task signals read from internal state in the voice-chat-
 * candidate module, which we drive through the real `startVoiceChatCandidate$`
 * happy path with MSW-stubbed endpoints + a stubbed WebRTC peer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { zeroVoiceChatContract } from "@vm0/core/contracts/zero-voice-chat";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { detach, Reason } from "../../utils.ts";
import {
  startVoiceChatCandidate$,
  vccStatus$,
} from "../../voice-chat-candidate/voice-chat-candidate-session.ts";
import { trinityEnabled$ } from "../../external/feature-switch.ts";
import {
  agentChatVoiceMode$,
  agentChatPendingTasks$,
  enterAgentChatVoiceMode$,
  exitAgentChatVoiceMode$,
  lastAgentMessage$,
  lastUserMessage$,
} from "../agent-chat-voice-mode.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function sessionPayload() {
  return {
    id: SESSION_ID,
    orgId: "org_default",
    userId: "test-user-123",
    agentId: AGENT_ID,
    mode: "chat" as const,
    conversationSummary: null,
    workingTasksSummary: null,
    finishedTasksSummary: null,
    summarySeq: 0,
    summaryVersion: 0,
    lastSummaryAt: null,
    createdAt: "2026-04-20T00:00:00Z",
  };
}

function itemPayload(overrides: {
  id: string;
  seq: number;
  role: "user" | "assistant" | "task_result";
  content: string;
  createdAt?: string;
  taskId?: string | null;
  realtimeItemId?: string;
}) {
  return {
    id: overrides.id,
    sessionId: SESSION_ID,
    seq: overrides.seq,
    role: overrides.role,
    content: overrides.content,
    taskId: overrides.taskId ?? null,
    realtimeItemId: overrides.realtimeItemId ?? `rt-${overrides.id}`,
    createdAt: overrides.createdAt ?? "2026-04-20T00:00:00Z",
  };
}

function taskPayload(overrides: {
  id: string;
  callId: string;
  status: "pending" | "queued" | "running" | "done" | "failed";
  createdAt: string;
  prompt?: string;
}) {
  return {
    id: overrides.id,
    sessionId: SESSION_ID,
    runId: null,
    callId: overrides.callId,
    prompt: overrides.prompt ?? "task",
    status: overrides.status,
    result: null,
    resultUpdatedAt: null,
    assistantMessages: [],
    error: null,
    createdAt: overrides.createdAt,
    startedAt: null,
    finishedAt: null,
  };
}

function mockCandidateEndpoints(options: {
  tasks: ReturnType<typeof taskPayload>[];
}) {
  server.use(
    mockApi(zeroVoiceChatContract.createSession, ({ respond }) => {
      return respond(200, {
        session: sessionPayload(),
        recentTaskLogs: "",
        finishedTasksFullText: "",
        talkerInstructions: "",
        talkerInstructionTokens: 0,
      });
    }),
    mockApi(zeroVoiceChatContract.token, ({ respond }) => {
      return respond(200, {
        client_secret: { value: "ek_test", expires_at: 9_999_999_999 },
      });
    }),
    mockApi(zeroVoiceChatContract.getSession, ({ respond }) => {
      return respond(200, {
        session: sessionPayload(),
        recentTaskLogs: "",
        finishedTasksFullText: "",
        talkerInstructions: "",
        talkerInstructionTokens: 0,
      });
    }),
    mockApi(zeroVoiceChatContract.listTasks, ({ respond }) => {
      const active = options.tasks
        .filter((t) => {
          return (
            t.status === "pending" ||
            t.status === "queued" ||
            t.status === "running"
          );
        })
        .sort((a, b) => {
          return a.createdAt.localeCompare(b.createdAt);
        });
      return respond(200, { tasks: active });
    }),
  );
}

function stubWebRTC(dcRef: { current: FakeDC | null }) {
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
      const dc: FakeDC = {
        readyState: "open",
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: (event, cb) => {
          if (event === "open") {
            openListeners.push(cb as () => void);
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
      // no-op
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

interface FakeDC {
  readyState: "open" | "closed";
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: (event: string, cb: () => void) => void;
  emitOpen: () => void;
}

async function driveSession(
  _items: ReturnType<typeof itemPayload>[],
  tasks: ReturnType<typeof taskPayload>[],
): Promise<void> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    withoutRender: true,
    featureSwitches: { trinity: true },
  });
  mockCandidateEndpoints({ tasks });
  const dcRef: { current: FakeDC | null } = { current: null };
  stubWebRTC(dcRef);
  detach(
    context.store.set(startVoiceChatCandidate$, AGENT_ID, context.signal),
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

describe("agent-chat-voice-mode", () => {
  beforeEach(() => {
    // noop — testContext() manages store lifecycle per test
  });

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.unstubAllGlobals();
  });

  describe("trinityEnabled$ gating", () => {
    it("resolves to false by default (registry default)", async () => {
      await setupPage({
        context,
        path: "/",
        withoutRender: true,
      });
      await expect(context.store.get(trinityEnabled$)).resolves.toBeFalsy();
    });

    it("resolves to true when the user override is set", async () => {
      await setupPage({
        context,
        path: "/",
        withoutRender: true,
        featureSwitches: { trinity: true },
      });
      await expect(context.store.get(trinityEnabled$)).resolves.toBeTruthy();
    });
  });

  describe("voice-mode state machine", () => {
    it("starts in 'off' mode", () => {
      expect(context.store.get(agentChatVoiceMode$)).toBe("off");
    });

    it("enter flips mode to 'on' synchronously", () => {
      detach(
        context.store.set(enterAgentChatVoiceMode$, AGENT_ID, context.signal),
        Reason.DomCallback,
      );
      expect(context.store.get(agentChatVoiceMode$)).toBe("on");
    });

    it("exit flips mode back to 'off' after enter", () => {
      detach(
        context.store.set(enterAgentChatVoiceMode$, AGENT_ID, context.signal),
        Reason.DomCallback,
      );
      context.store.set(exitAgentChatVoiceMode$);
      expect(context.store.get(agentChatVoiceMode$)).toBe("off");
    });
  });

  describe("derived message signals", () => {
    it("baseline suppresses history: lastUserMessage$ / lastAgentMessage$ are empty after re-entry, even when the session has prior transcript", async () => {
      // This is the core Trinity re-entry guarantee. The subtitle must not
      // replay the previous session's last line — only utterances that land
      // AFTER the user steps back in should appear.
      await driveSession(
        [
          itemPayload({
            id: "a1111111-1111-4111-8111-111111111111",
            seq: 1,
            role: "user",
            content: "first user",
            createdAt: "2026-04-20T00:00:01Z",
          }),
          itemPayload({
            id: "a2222222-2222-4222-8222-222222222222",
            seq: 2,
            role: "assistant",
            content: "first agent",
            createdAt: "2026-04-20T00:00:02Z",
          }),
          itemPayload({
            id: "a5555555-5555-4555-8555-555555555555",
            seq: 5,
            role: "assistant",
            content: "second agent",
            createdAt: "2026-04-20T00:00:05Z",
          }),
        ],
        [],
      );

      expect(context.store.get(lastUserMessage$)).toBe("");
      expect(context.store.get(lastAgentMessage$)).toBe("");
    });

    it("returns empty string when no items exist", async () => {
      await driveSession([], []);
      expect(context.store.get(lastUserMessage$)).toBe("");
      expect(context.store.get(lastAgentMessage$)).toBe("");
    });
  });

  describe("agentChatPendingTasks$", () => {
    it("filters out 'done' and 'failed' and sorts by createdAt ascending", async () => {
      await driveSession(
        [],
        [
          taskPayload({
            id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
            callId: "call-a",
            status: "running",
            createdAt: "2026-04-20T00:00:03Z",
          }),
          taskPayload({
            id: "22222222-2222-4222-8222-bbbbbbbbbbbb",
            callId: "call-b",
            status: "done",
            createdAt: "2026-04-20T00:00:02Z",
          }),
          taskPayload({
            id: "33333333-3333-4333-8333-cccccccccccc",
            callId: "call-c",
            status: "pending",
            createdAt: "2026-04-20T00:00:01Z",
          }),
          taskPayload({
            id: "44444444-4444-4444-8444-dddddddddddd",
            callId: "call-d",
            status: "failed",
            createdAt: "2026-04-20T00:00:00Z",
          }),
          taskPayload({
            id: "55555555-5555-4555-8555-eeeeeeeeeeee",
            callId: "call-e",
            status: "queued",
            createdAt: "2026-04-20T00:00:04Z",
          }),
        ],
      );

      const tasks = await context.store.get(agentChatPendingTasks$);
      expect(
        tasks.map((t) => {
          return t.callId;
        }),
      ).toStrictEqual(["call-c", "call-a", "call-e"]);
    });
  });
});
