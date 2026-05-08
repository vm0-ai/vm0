// Hono WS upgrade endpoint for the voice-chat realtime relay. Registered in
// `app-factory.ts` outside the ts-rest `ROUTES` array because a WS upgrade
// is not a ts-rest contract route.
//
// Token verification is provided by the local stub today (see
// `local-relay-token.ts`); after sub-issue #12140 lands, this file imports
// `verifyRelayToken` from `@vm0/core/voice-chat/relay-token` instead.
//
// The instructions string is a placeholder in this PR — sub-issue #12140's
// bootstrap is responsible for sourcing the real Talker prompt (built by
// the Reasoner in apps/web) and threading it into the relay either via the
// token claims or a separate setup channel. Tracked as a follow-up; without
// real instructions the Talker still operates with a generic system prompt.

import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { WebSocket as WsWebSocket } from "ws";

import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { verifyRelayToken } from "./local-relay-token";
import { runRelay } from "./relay-loop";
import type { RelaySessionRepository } from "./relay-session-repository";

// Placeholder Talker prompt used until #12140 wires real instructions
// through. Kept short on purpose — observability prefers a recognisable
// string over a copy of the real prompt that would silently outdate.
const PLACEHOLDER_INSTRUCTIONS =
  "Talker placeholder instructions — sub-issue #12140 wires the real prompt.";

// Hono's `WSMessageReceive` is `string | Blob | ArrayBufferLike`. On the
// Node `ws` adapter the browser path delivers either string frames or
// `Buffer` (which is `ArrayBufferLike`-compatible). Blob is technically
// possible but never produced server-side — drop those silently rather
// than synchronously block on a Blob.arrayBuffer() promise inside a
// non-async event handler.
function decodeIncoming(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return null;
}

export interface RegisterVoiceChatRelayRouteOptions {
  readonly app: Hono;
  readonly upgradeWebSocket: UpgradeWebSocket<WsWebSocket>;
  readonly signal: AbortSignal;
  // Required: the relay-session repository the loop writes lifecycle rows
  // into. createAppWithWebSocket constructs an in-memory implementation by
  // default until #12138 ships the real table.
  readonly repository: RelaySessionRepository;
  // Test seam — points the OpenAI client at a fake `ws://127.0.0.1:<port>`
  // server.
  readonly openAiUrl?: string;
}

const RELAY_ROUTE_PATH = "/api/zero/voice-chat/relay";

export function registerVoiceChatRelayRoute(
  options: RegisterVoiceChatRelayRouteOptions,
): void {
  const repo = options.repository;

  options.app.get(
    RELAY_ROUTE_PATH,
    options.upgradeWebSocket((c) => {
      // VOICE_CHAT_RELAY_TOKEN_SECRET is optional in the env schema (so
      // non-relay deployments don't fail validation), but the relay path
      // cannot run without it. Fail-closed with WS close 1011 if unset —
      // tests stub it via env-stub.ts, dev pulls it through
      // `scripts/sync-env.sh`, production must set it (sub-issue #12140's
      // contract).
      const relaySecret = env("VOICE_CHAT_RELAY_TOKEN_SECRET");
      if (relaySecret === undefined) {
        return {
          onOpen: (_evt, ws) => {
            ws.close(1011, "relay token secret not configured");
          },
        };
      }
      const token = c.req.query("token") ?? "";
      const verifyResult = verifyRelayToken(token, {
        nowSeconds: Math.floor(now() / 1000),
        secret: relaySecret,
      });
      if (!verifyResult.ok) {
        return {
          onOpen: (_evt, ws) => {
            ws.close(verifyResult.closeCode, "relay token rejected");
          },
        };
      }
      const claims = verifyResult.claims;
      // OPENAI_API_KEY is required by the env zod schema (z.string().min(1))
      // — `env()` throws on boot if it is unset, so it is always defined
      // here.
      const apiKey = env("OPENAI_API_KEY");

      let pending: string[] = [];
      let dispatch: ((data: string) => void) | null = null;
      let closeHandler: ((code: number, reason: string) => void) | null = null;
      let errorHandler: ((err: Error) => void) | null = null;

      return {
        onOpen: (_evt, ws) => {
          const browserSocket = {
            send: (data: string) => {
              ws.send(data);
            },
            close: (code?: number, reason?: string) => {
              ws.close(code, reason);
            },
            onMessage: (handler: (data: string) => void) => {
              dispatch = handler;
              for (const msg of pending) {
                handler(msg);
              }
              pending = [];
            },
            onClose: (handler: (code: number, reason: string) => void) => {
              closeHandler = handler;
            },
            onError: (handler: (err: Error) => void) => {
              errorHandler = handler;
            },
          };
          // Fire-and-forget; runRelay manages its own lifecycle and writes
          // terminal status into the repository regardless of how this
          // promise settles. `.catch` here covers the rare case where
          // `runRelay` throws synchronously inside its own setup — the
          // browser socket has already been closed by that point and the
          // log line is the only useful artifact.
          runRelay({
            browserSocket,
            voiceChatSessionId: claims.voiceChatSessionId,
            userId: claims.userId,
            orgId: claims.orgId,
            instructions: PLACEHOLDER_INSTRUCTIONS,
            signal: options.signal,
            repo,
            openAiApiKey: apiKey,
            openAiUrl: options.openAiUrl,
          }).catch((error: unknown) => {
            // runRelay swallows its own internal errors via terminateError.
            // This catch is for the rare path where runRelay throws
            // synchronously before reaching that code (e.g. an exception
            // inside `repo.insertStarting`). Best effort: close the socket
            // — Hono's WSContext.close is no-throw, so no guard needed.
            const message =
              error instanceof Error ? error.message : "runRelay threw";
            ws.close(1011, message.slice(0, 100));
          });
        },
        onMessage: (evt) => {
          const data = decodeIncoming(evt.data);
          if (data === null) {
            return;
          }
          if (dispatch !== null) {
            dispatch(data);
          } else {
            pending.push(data);
          }
        },
        onClose: (evt) => {
          if (closeHandler !== null) {
            closeHandler(evt.code, evt.reason);
          }
        },
        onError: () => {
          if (errorHandler !== null) {
            errorHandler(new Error("browser socket error"));
          }
        },
      };
    }),
  );
}
