import {
  zeroRunsByIdContract,
  zeroRunsQueueContract,
  zeroRunsCancelContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
} from "@okouai/api-contracts/contracts/zero-runs";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { zeroQueuePositionContract } from "@okouai/api-contracts/contracts/zero-queue-position";
import { mockApi } from "../msw-contract.ts";

export const apiRunsHandlers = [
  // GET /api/okou/runs/:id
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

  // GET /api/okou/runs/queue
  mockApi(zeroRunsQueueContract.getQueue, ({ respond }) =>
    respond(200, {
      concurrency: {
        tier: "free",
        limit: 1,
        active: 0,
        available: 1,
        memberUsage: [],
      },
      queue: [],
      runningTasks: [],
      estimatedTimePerRun: 30_000,
    }),
  ),

  // POST /api/okou/runs/:id/cancel
  mockApi(zeroRunsCancelContract.cancel, ({ params, respond }) =>
    respond(200, {
      id: params.id,
      status: "cancelled",
      message: "Run cancelled",
    }),
  ),

  // GET /api/okou/runs/:id/context
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
      featureFlags: null,
    }),
  ),

  // GET /api/okou/runs/:id/network
  mockApi(zeroRunNetworkLogsContract.getNetworkLogs, ({ respond }) =>
    respond(200, { networkLogs: [], hasMore: false }),
  ),

  // POST /api/okou/chat/events
  mockApi(chatEventsContract.send, ({ respond }) =>
    respond(201, {
      runId: "a0000000-0000-4000-a000-000000000001",
      threadId: "b0000000-0000-4000-a000-000000000001",
      status: "pending",
      createdAt: "2026-03-10T00:00:00Z",
    }),
  ),

  // GET /api/okou/queue-position
  mockApi(zeroQueuePositionContract.getPosition, ({ respond }) =>
    respond(200, { position: 0, total: 0 }),
  ),
];
