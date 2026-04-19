/**
 * Runs API Handlers
 *
 * Mock handlers for run-related endpoints.
 * Default behavior: no active runs.
 */

import {
  zeroRunsByIdContract,
  zeroRunAgentEventsContract,
  zeroRunsQueueContract,
  zeroRunsCancelContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
  chatMessagesContract,
  zeroQueuePositionContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

export const apiRunsHandlers = [
  // GET /api/zero/runs/:id
  mockApi(zeroRunsByIdContract.getById, ({ respond }) =>
    respond(200, {
      runId: "a0000000-0000-4000-a000-000000000001",
      agentComposeVersionId: null,
      status: "completed",
      prompt: "Test prompt",
      appendSystemPrompt: null,
      result: { agentSessionId: "session-1", output: "" },
      createdAt: "2026-03-10T00:00:00Z",
    }),
  ),

  // GET /api/zero/runs/:id/telemetry/agent
  mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) =>
    respond(200, { events: [], hasMore: false, framework: "claude-code" }),
  ),

  // GET /api/zero/runs/queue
  mockApi(zeroRunsQueueContract.getQueue, ({ respond }) =>
    respond(200, {
      concurrency: { tier: "free", limit: 1, active: 0, available: 1 },
      queue: [],
      runningTasks: [],
      estimatedTimePerRun: 30_000,
    }),
  ),

  // POST /api/zero/runs/:id/cancel
  mockApi(zeroRunsCancelContract.cancel, ({ params, respond }) =>
    respond(200, {
      id: params.id,
      status: "cancelled",
      message: "Run cancelled",
    }),
  ),

  // GET /api/zero/runs/:id/context
  mockApi(zeroRunContextContract.getContext, ({ params, respond }) =>
    respond(200, {
      prompt: "Test prompt",
      appendSystemPrompt: null,
      runId: params.id,
      sessionId: null,
      secretNames: [],
      vars: null,
      environment: {},
      firewalls: [],
      networkPolicies: null,
      volumes: [],
      artifact: null,
      memory: null,
      featureFlags: null,
    }),
  ),

  // GET /api/zero/runs/:id/network
  mockApi(zeroRunNetworkLogsContract.getNetworkLogs, ({ respond }) =>
    respond(200, { networkLogs: [], hasMore: false }),
  ),

  // POST /api/zero/chat/messages
  mockApi(chatMessagesContract.send, ({ respond }) =>
    respond(201, {
      runId: "a0000000-0000-4000-a000-000000000001",
      threadId: "b0000000-0000-4000-a000-000000000001",
      status: "pending",
      createdAt: "2026-03-10T00:00:00Z",
    }),
  ),

  // GET /api/zero/queue-position
  mockApi(zeroQueuePositionContract.getPosition, ({ respond }) =>
    respond(200, { position: 0, total: 0 }),
  ),
];
