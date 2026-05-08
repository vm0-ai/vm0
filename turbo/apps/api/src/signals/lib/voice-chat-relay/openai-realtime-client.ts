// WebSocket client to OpenAI Realtime. Owns the `wss://api.openai.com/v1/realtime`
// connection and translates between raw frames and the parsed event union in
// event-types.ts. Bytewise equality with the legacy `createEphemeralToken`
// REST body is load-bearing for billing parity (see plan §0); the
// `session.update` payload is built from `@vm0/core/voice-chat/session-config`
// so a single source of truth governs both paths.

import { WebSocket as WsWebSocket } from "ws";

import {
  DEFAULT_NOISE_REDUCTION,
  INPUT_AUDIO_TRANSCRIPTION_CONFIG,
  SESSION_MODALITIES,
  SESSION_TOOLS,
  TALKER_MODEL,
  TALKER_VOICE,
  TURN_DETECTION_CONFIG,
  type NoiseReduction,
} from "@vm0/core/voice-chat/session-config";

import { logger } from "../../../lib/log";

import { parseOpenAiEvent, type ParsedOpenAiEvent } from "./event-types";

const log = logger("zero:voice-chat:realtime-relay:openai-client");

const OPENAI_REALTIME_WS_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";

export interface OpenAiSessionUpdate {
  readonly type: "session.update";
  readonly session: Readonly<Record<string, unknown>>;
}

export type OutgoingOpenAiEvent =
  | OpenAiSessionUpdate
  | { readonly type: string; readonly [key: string]: unknown };

export interface OpenAiRealtimeClient {
  readonly open: (opts: {
    readonly instructions: string;
    readonly noiseReduction?: NoiseReduction;
  }) => Promise<{ readonly openaiSessionId: string }>;
  readonly send: (event: OutgoingOpenAiEvent) => void;
  readonly onEvent: (
    handler: (event: ParsedOpenAiEvent) => void | Promise<void>,
  ) => void;
  readonly onClose: (handler: (code: number, reason: string) => void) => void;
  readonly onError: (handler: (err: Error) => void) => void;
  readonly close: (code?: number, reason?: string) => void;
}

export interface OpenAiRealtimeClientOptions {
  readonly url?: string;
  readonly apiKey: string;
  // Test seam: lets `openai-realtime-client.test.ts` swap in a stub `ws`
  // implementation without an actual TCP connection.
  readonly webSocketCtor?: typeof WsWebSocket;
}

// Bytewise template the relay sends as the first frame after WS open. The
// shape mirrors what `createEphemeralToken` POSTs to the legacy REST endpoint
// (modulo the per-call `instructions` and `input_audio_noise_reduction.type`).
// Snapshot tests assert this shape so accidental drift fails CI.
export function buildSessionUpdate(opts: {
  readonly instructions: string;
  readonly noiseReduction?: NoiseReduction;
}): OpenAiSessionUpdate {
  return {
    type: "session.update",
    session: {
      model: TALKER_MODEL,
      voice: TALKER_VOICE,
      modalities: SESSION_MODALITIES,
      instructions: opts.instructions,
      input_audio_transcription: INPUT_AUDIO_TRANSCRIPTION_CONFIG,
      input_audio_noise_reduction: {
        type: opts.noiseReduction ?? DEFAULT_NOISE_REDUCTION,
      },
      turn_detection: TURN_DETECTION_CONFIG,
      tools: SESSION_TOOLS,
    },
  };
}

interface PendingOpen {
  readonly resolve: (result: { readonly openaiSessionId: string }) => void;
  readonly reject: (err: Error) => void;
}

export function createOpenAiRealtimeClient(
  options: OpenAiRealtimeClientOptions,
): OpenAiRealtimeClient {
  const url = options.url ?? OPENAI_REALTIME_WS_URL;
  const Ctor = options.webSocketCtor ?? WsWebSocket;
  let socket: WsWebSocket | null = null;
  let eventHandler: ((e: ParsedOpenAiEvent) => void | Promise<void>) | null =
    null;
  let closeHandler: ((code: number, reason: string) => void) | null = null;
  let errorHandler: ((err: Error) => void) | null = null;
  let pendingOpen: PendingOpen | null = null;

  function dispatchEvent(event: ParsedOpenAiEvent): void {
    if (event.kind === "session.created" && pendingOpen !== null) {
      const pending = pendingOpen;
      pendingOpen = null;
      pending.resolve({ openaiSessionId: event.openaiSessionId });
    }
    if (eventHandler !== null) {
      const result = eventHandler(event);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          // Surface unexpected handler rejections to the logger so they reach
          // production telemetry. Routing through `errorHandler` would
          // tear down the relay session for a handler-side bug, which is too
          // destructive — the relay-loop already wraps its own handler with
          // a defensive log; this catch is the safety net for any future
          // direct callers.
          log.error("openai client event handler rejected", {
            errorMessage:
              error instanceof Error ? error.message : "unknown handler error",
          });
        });
      }
    }
  }

  return {
    open(opts) {
      if (socket !== null) {
        return Promise.reject(new Error("OpenAiRealtimeClient already opened"));
      }
      const ws = new Ctor(url, {
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
      socket = ws;
      const opened = new Promise<{ readonly openaiSessionId: string }>(
        (resolve, reject) => {
          pendingOpen = { resolve, reject };
        },
      );
      ws.on("open", () => {
        ws.send(JSON.stringify(buildSessionUpdate(opts)));
      });
      ws.on("message", (data) => {
        const text =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString("utf8")
              : Array.isArray(data)
                ? Buffer.concat(data).toString("utf8")
                : Buffer.from(data as ArrayBuffer).toString("utf8");
        const result = parseOpenAiEvent(text);
        if (result.ok) {
          dispatchEvent(result.event);
        }
      });
      ws.on("error", (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (pendingOpen !== null) {
          const pending = pendingOpen;
          pendingOpen = null;
          pending.reject(error);
        }
        if (errorHandler !== null) {
          errorHandler(error);
        }
      });
      ws.on("close", (code, reason) => {
        const reasonText = reason.toString("utf8");
        if (pendingOpen !== null) {
          const pending = pendingOpen;
          pendingOpen = null;
          pending.reject(
            new Error(
              `OpenAI WS closed before session.created (code=${code} reason=${reasonText})`,
            ),
          );
        }
        if (closeHandler !== null) {
          closeHandler(code, reasonText);
        }
      });
      return opened;
    },
    send(event) {
      if (socket === null || socket.readyState !== socket.OPEN) {
        return;
      }
      socket.send(JSON.stringify(event));
    },
    onEvent(handler) {
      eventHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    onError(handler) {
      errorHandler = handler;
    },
    close(code, reason) {
      if (socket === null) {
        return;
      }
      // ws.WebSocket.close throws if state is CLOSING / CLOSED; check
      // readyState first instead of guarding with try/catch.
      if (
        socket.readyState === socket.CONNECTING ||
        socket.readyState === socket.OPEN
      ) {
        socket.close(code, reason);
      } else if (socket.readyState !== socket.CLOSED) {
        socket.terminate();
      }
    },
  };
}
