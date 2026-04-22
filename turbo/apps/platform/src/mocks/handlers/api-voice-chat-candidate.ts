/**
 * Voice Chat Candidate API Handlers
 *
 * Mock handlers for /api/zero/voice-chat-candidate endpoints.
 * Stateful: sessions, items, and tasks persist for the lifetime of a test
 * run; call resetMockVoiceChatCandidate() between cases for isolation.
 */

import {
  zeroVoiceChatCandidateContract,
  type VoiceChatCandidateSession,
  type VoiceChatCandidateItem,
  type VoiceChatCandidateTask,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

const MOCK_ORG_ID = "mock-org";
const MOCK_USER_ID = "mock-user";
const EPHEMERAL_TOKEN_TTL_SECONDS = 60;

let mockSessions = new Map<string, VoiceChatCandidateSession>();
let mockItems = new Map<string, VoiceChatCandidateItem[]>();
let mockTasks = new Map<string, VoiceChatCandidateTask>();

export function resetMockVoiceChatCandidate(): void {
  mockSessions = new Map();
  mockItems = new Map();
  mockTasks = new Map();
}

export const apiVoiceChatCandidateHandlers = [
  mockApi(zeroVoiceChatCandidateContract.createSession, ({ body, respond }) => {
    const now = new Date().toISOString();
    const session: VoiceChatCandidateSession = {
      id: crypto.randomUUID(),
      orgId: MOCK_ORG_ID,
      userId: MOCK_USER_ID,
      agentId: body.agentId,
      mode: "chat",
      status: "active",
      conversationSummary: null,
      workingTasksSummary: null,
      finishedTasksSummary: null,
      summarySeq: 0,
      summaryVersion: 0,
      lastSummaryAt: null,
      createdAt: now,
      lastHeartbeatAt: now,
      endedAt: null,
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

  mockApi(zeroVoiceChatCandidateContract.getSession, ({ params, respond }) => {
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

  mockApi(zeroVoiceChatCandidateContract.listSessions, ({ respond }) => {
    return respond(200, { sessions: Array.from(mockSessions.values()) });
  }),

  mockApi(
    zeroVoiceChatCandidateContract.reenterSession,
    ({ params, respond }) => {
      const session = mockSessions.get(params.id);
      if (!session) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }
      session.status = "active";
      session.endedAt = null;
      session.lastHeartbeatAt = new Date().toISOString();
      return respond(200, {
        session,
        recentTaskLogs: "",
        finishedTasksFullText: "",
        talkerInstructions: "",
        talkerInstructionTokens: 0,
      });
    },
  ),

  mockApi(zeroVoiceChatCandidateContract.endSession, ({ params, respond }) => {
    const session = mockSessions.get(params.id);
    if (!session) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }
    session.status = "ended";
    session.endedAt = new Date().toISOString();
    return respond(200, { ok: true });
  }),

  mockApi(zeroVoiceChatCandidateContract.heartbeat, ({ params, respond }) => {
    const session = mockSessions.get(params.id);
    if (!session || session.status !== "active") {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Active session not found" },
      });
    }
    session.lastHeartbeatAt = new Date().toISOString();
    return respond(200, { ok: true });
  }),

  mockApi(
    zeroVoiceChatCandidateContract.appendItem,
    ({ params, body, respond }) => {
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
      const item: VoiceChatCandidateItem = {
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
    },
  ),

  mockApi(
    zeroVoiceChatCandidateContract.readItems,
    ({ params, query, respond }) => {
      const sessionId = params.id;
      const session = mockSessions.get(sessionId);
      if (!session) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }
      const sessionItems = mockItems.get(sessionId) ?? [];
      const after = query.after;
      const items =
        after !== undefined
          ? sessionItems.filter((i) => i.seq > after)
          : sessionItems;
      return respond(200, { items });
    },
  ),

  mockApi(
    zeroVoiceChatCandidateContract.createTask,
    ({ params, body, respond }) => {
      const sessionId = params.id;
      const session = mockSessions.get(sessionId);
      if (!session) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }
      const task: VoiceChatCandidateTask = {
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
    },
  ),

  mockApi(zeroVoiceChatCandidateContract.listTasks, ({ params, respond }) => {
    const sessionId = params.id;
    const session = mockSessions.get(sessionId);
    if (!session) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Session not found" },
      });
    }
    const tasks = Array.from(mockTasks.values())
      .filter((t) => {
        return t.sessionId === sessionId;
      })
      .sort((a, b) => {
        return b.createdAt.localeCompare(a.createdAt);
      });
    return respond(200, { tasks });
  }),

  mockApi(zeroVoiceChatCandidateContract.token, ({ respond }) => {
    return respond(200, {
      client_secret: {
        value: "mock-ephemeral-token",
        expires_at: Math.floor(Date.now() / 1000) + EPHEMERAL_TOKEN_TTL_SECONDS,
      },
    });
  }),
];
