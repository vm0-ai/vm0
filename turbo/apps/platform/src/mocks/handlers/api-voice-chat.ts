/**
 * Voice Chat API Handlers
 *
 * Mock handlers for /api/zero/voice-chat-candidate endpoints.
 * Stateful: sessions, items, and tasks persist for the lifetime of a test
 * run; call resetMockVoiceChat() between cases for isolation.
 */

import {
  zeroVoiceChatContract,
  type VoiceChatSession,
  type VoiceChatItem,
  type VoiceChatTask,
} from "@vm0/core/contracts/zero-voice-chat";
import { mockApi } from "../msw-contract.ts";

const MOCK_ORG_ID = "mock-org";
const MOCK_USER_ID = "mock-user";
const EPHEMERAL_TOKEN_TTL_SECONDS = 60;

let mockSessions = new Map<string, VoiceChatSession>();
let mockItems = new Map<string, VoiceChatItem[]>();
let mockTasks = new Map<string, VoiceChatTask>();

export function resetMockVoiceChat(): void {
  mockSessions = new Map();
  mockItems = new Map();
  mockTasks = new Map();
}

export const apiVoiceChatHandlers = [
  mockApi(zeroVoiceChatContract.createSession, ({ body, respond }) => {
    // Get-or-create by (userId, agentId): if an existing mock session
    // matches the agent, return it instead of creating a fresh row.
    const existing = Array.from(mockSessions.values()).find((s) => {
      return s.userId === MOCK_USER_ID && s.agentId === body.agentId;
    });
    if (existing) {
      return respond(200, {
        session: existing,
        recentTaskLogs: "",
        finishedTasksFullText: "",
        talkerInstructions: "",
        talkerInstructionTokens: 0,
      });
    }
    const now = new Date().toISOString();
    const session: VoiceChatSession = {
      id: crypto.randomUUID(),
      orgId: MOCK_ORG_ID,
      userId: MOCK_USER_ID,
      agentId: body.agentId,
      mode: "chat",
      conversationSummary: null,
      workingTasksSummary: null,
      finishedTasksSummary: null,
      summarySeq: 0,
      summaryVersion: 0,
      lastSummaryAt: null,
      createdAt: now,
    };
    mockSessions.set(session.id, session);
    mockItems.set(session.id, []);
    return respond(200, {
      session,
      recentTaskLogs: "",
      finishedTasksFullText: "",
      talkerInstructions: "",
      talkerInstructionTokens: 0,
    });
  }),

  mockApi(zeroVoiceChatContract.getSession, ({ params, respond }) => {
    const session = mockSessions.get(params.id);
    if (!session) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }
    return respond(200, {
      session,
      recentTaskLogs: "",
      finishedTasksFullText: "",
      talkerInstructions: "",
      talkerInstructionTokens: 0,
    });
  }),

  mockApi(zeroVoiceChatContract.listSessions, ({ respond }) => {
    return respond(200, { sessions: Array.from(mockSessions.values()) });
  }),

  mockApi(zeroVoiceChatContract.triggerReasoning, ({ params, respond }) => {
    const session = mockSessions.get(params.id);
    if (!session) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }
    return respond(200, { ok: true });
  }),

  mockApi(zeroVoiceChatContract.appendItem, ({ params, body, respond }) => {
    const sessionId = params.id;
    const session = mockSessions.get(sessionId);
    if (!session) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }
    const sessionItems = mockItems.get(sessionId) ?? [];
    const existing = sessionItems.find(
      (i) => i.realtimeItemId === body.realtimeItemId,
    );
    if (existing) {
      return respond(200, { item: existing });
    }
    const item: VoiceChatItem = {
      id: crypto.randomUUID(),
      sessionId,
      seq: sessionItems.length + 1,
      role: body.role,
      content: body.content,
      taskId: null,
      realtimeItemId: body.realtimeItemId,
      createdAt: new Date().toISOString(),
    };
    sessionItems.push(item);
    mockItems.set(sessionId, sessionItems);
    return respond(200, { item });
  }),

  mockApi(zeroVoiceChatContract.createTask, ({ params, body, respond }) => {
    const sessionId = params.id;
    const session = mockSessions.get(sessionId);
    if (!session) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }
    const task: VoiceChatTask = {
      id: crypto.randomUUID(),
      sessionId,
      runId: null,
      callId: body.callId,
      prompt: body.prompt,
      status: "pending",
      result: null,
      resultUpdatedAt: null,
      assistantMessages: [],
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    mockTasks.set(task.id, task);
    return respond(200, { task });
  }),

  mockApi(zeroVoiceChatContract.listTasks, ({ params, respond }) => {
    const sessionId = params.id;
    const session = mockSessions.get(sessionId);
    if (!session) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }
    const all = Array.from(mockTasks.values()).filter((t) => {
      return t.sessionId === sessionId;
    });
    const active = all
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
    const finished = all
      .filter((t) => {
        return t.status === "done" || t.status === "failed";
      })
      .sort((a, b) => {
        return (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "");
      })
      .slice(0, 3);
    return respond(200, { tasks: [...active, ...finished] });
  }),

  mockApi(zeroVoiceChatContract.token, ({ respond }) => {
    return respond(200, {
      client_secret: {
        value: "mock-ephemeral-token",
        expires_at: Math.floor(Date.now() / 1000) + EPHEMERAL_TOKEN_TTL_SECONDS,
      },
    });
  }),
];
