/**
 * Voice Chat API Handlers
 *
 * Mock handlers for /api/zero/voice-chat endpoints.
 * Default behavior: noop responses so tests that don't need to control
 * voice-chat state don't produce unhandled-request warnings.
 */

import {
  zeroVoiceChatPrepareTriggerContract,
  zeroVoiceChatPrepareListContract,
  zeroVoiceChatSessionsContract,
  zeroVoiceChatContextContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

export const apiVoiceChatHandlers = [
  mockApi(zeroVoiceChatPrepareTriggerContract.trigger, ({ respond }) => {
    return respond(200, {
      preparation: { id: "prep-noop", status: "ready" },
    });
  }),

  mockApi(zeroVoiceChatPrepareListContract.list, ({ respond }) => {
    return respond(200, { preparations: [] });
  }),

  mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
    return respond(200, {
      session: {
        id: "vc-default",
        mode: "chat",
        status: "preparing",
        runId: "run-default",
        createdAt: "2026-01-01T00:00:00Z",
        prepared: false,
      },
    });
  }),

  mockApi(zeroVoiceChatSessionsContract.token, ({ respond }) => {
    return respond(200, {
      client_secret: { value: "mock-token", expires_at: 9_999_999_999 },
    });
  }),

  mockApi(zeroVoiceChatSessionsContract.heartbeat, ({ respond }) => {
    return respond(200, { ok: true });
  }),

  mockApi(zeroVoiceChatSessionsContract.activate, ({ params, respond }) => {
    return respond(200, {
      session: { id: params.id, mode: "chat", status: "active" },
    });
  }),

  mockApi(zeroVoiceChatSessionsContract.end, ({ respond }) => {
    return respond(200, { ok: true });
  }),

  mockApi(zeroVoiceChatContextContract.getEvents, ({ respond }) => {
    return respond(200, { events: [] });
  }),
];
