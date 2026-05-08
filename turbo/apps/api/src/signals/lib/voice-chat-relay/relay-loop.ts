// The relay loop. Owns the row-state lifecycle and the bidirectional
// pass-through between the browser socket and the OpenAI Realtime client.
//
// Sibling sub-issues plug behavior in via `onProviderEvent`:
//   - #12141: transcript ingestion + Talker tool dispatch.
//   - #12142: usage settlement + credit-driven shutdown.
// Their handlers receive every parsed OpenAI event plus a `RelayContext`
// exposing `sendToOpenAi(event)` (so #12141 can reply with `function_call_output`)
// and `endRelay(reason)` (so #12142 can close on credit exhaustion).
//
// Row writes go through a `RelaySessionRepository` port — the in-memory
// implementation suffices for this PR; the drizzle implementation lands
// after #12138 ships the table.

import {
  INPUT_AUDIO_TRANSCRIPTION_CONFIG,
  TALKER_MODEL,
} from "@vm0/core/voice-chat/session-config";

import {
  parseBrowserEvent,
  type BrowserEvent,
  type ParsedOpenAiEvent,
  type RelayEnvelopeEvent,
} from "./event-types";
import {
  createOpenAiRealtimeClient,
  type OpenAiRealtimeClient,
  type OpenAiRealtimeClientOptions,
  type OutgoingOpenAiEvent,
} from "./openai-realtime-client";
import {
  relayLogger,
  type RelayLogContext,
  type RelayLogger,
} from "./relay-logger";
import type { RelaySessionRepository } from "./relay-session-repository";

// `terminateError` / `terminateGracefully` / `terminateAborted` already swallow
// internal failures via try/catch; `fireAndForget` exists to satisfy
// `no-floating-promises` without re-routing every cleanup site through an
// `await` chain that doesn't model the actual control flow (these run from
// event-loop callbacks that can't await).
function fireAndForget(p: Promise<void>): void {
  p.catch(() => {
    // Cleanup helpers handle their own errors internally; nothing to do here.
  });
}

export interface BrowserSocketLike {
  // Pure side-effect; implementations swallow "socket already closed"
  // failures internally (the WS adapter checks readyState before send/close)
  // so the relay-loop never has to wrap calls in try/catch.
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly onMessage: (handler: (data: string) => void) => void;
  readonly onClose: (handler: (code: number, reason: string) => void) => void;
  readonly onError: (handler: (err: Error) => void) => void;
}

export interface RelayContext {
  readonly relaySessionId: string;
  readonly voiceChatSessionId: string;
  readonly orgId: string;
  readonly userId: string;
  // Send a JSON event to OpenAI on the relay's behalf. Used by sibling
  // handlers (e.g. #12141 sending `function_call_output` for tool replies).
  readonly sendToOpenAi: (event: OutgoingOpenAiEvent) => void;
  // Request a graceful end of the relay session. Used by #12142 when org
  // credits hit zero. The browser receives `relay.closed` with reason
  // "session_ended" and the row is marked `status='ended'`.
  readonly endRelay: (reason: "session_ended") => void;
}

export interface ProviderEventHandlers {
  onProviderEvent: (
    event: ParsedOpenAiEvent,
    ctx: RelayContext,
  ) => void | Promise<void>;
}

const NO_OP_PROVIDER_HANDLERS: Readonly<ProviderEventHandlers> = Object.freeze({
  onProviderEvent: () => {},
});

interface RunRelayOptions {
  readonly browserSocket: BrowserSocketLike;
  readonly voiceChatSessionId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly instructions: string;
  readonly signal: AbortSignal;
  readonly repo: RelaySessionRepository;
  readonly handlers?: ProviderEventHandlers;
  readonly openAiClientFactory?: (
    opts: OpenAiRealtimeClientOptions,
  ) => OpenAiRealtimeClient;
  readonly openAiApiKey: string;
  readonly openAiUrl?: string;
}

interface InternalState {
  readonly relaySessionId: string;
  readonly log: RelayLogger;
  readonly client: OpenAiRealtimeClient;
  readonly handlers: ProviderEventHandlers;
  openaiSessionId: string | null;
  terminated: boolean;
}

function sendEnvelope(
  socket: BrowserSocketLike,
  envelope: RelayEnvelopeEvent,
): void {
  // BrowserSocketLike.send is contractually no-throw — adapter swallows
  // "already closed" failures internally.
  socket.send(JSON.stringify(envelope));
}

function forwardBrowserEvent(
  state: InternalState,
  raw: Readonly<Record<string, unknown>>,
): void {
  state.client.send(raw as OutgoingOpenAiEvent);
}

async function handleOpenAiEvent(
  state: InternalState,
  event: ParsedOpenAiEvent,
  browserSocket: BrowserSocketLike,
  repo: RelaySessionRepository,
  ctx: RelayContext,
): Promise<void> {
  if (event.kind === "session.created") {
    state.openaiSessionId = event.openaiSessionId;
    await repo.markActive(state.relaySessionId, event.openaiSessionId);
    sendEnvelope(browserSocket, {
      type: "relay.ready",
      relaySessionId: state.relaySessionId,
      openaiSessionId: event.openaiSessionId,
      model: TALKER_MODEL,
    });
    state.log.debug("relay session active", {
      eventType: "session.created",
    });
  }
  // Hook fires for every event after row-state side effects, before the
  // forward to the browser. Promise rejections are absorbed via .catch so a
  // billing miss does not silently kill a live conversation; #12142 chooses
  // how to react itself.
  await Promise.resolve(state.handlers.onProviderEvent(event, ctx)).catch(
    (error: unknown) => {
      state.log.error("provider event handler threw", {
        eventType: event.kind,
        errorMessage:
          error instanceof Error ? error.message : "unknown handler error",
      });
    },
  );
  // Forward verbatim raw JSON so the platform handlers in #12142 see the
  // exact OpenAI shape they already understand. send is contractually
  // no-throw on BrowserSocketLike.
  browserSocket.send(JSON.stringify(event.raw));
}

function wireOpenAiClient(
  state: InternalState,
  browserSocket: BrowserSocketLike,
  repo: RelaySessionRepository,
  ctx: RelayContext,
): void {
  // Serialize event delivery so handlers and forwarding observe events in
  // the same order they arrive on the OpenAI WS, even when handler work is
  // async. Without this chain a fast handler for event N+1 can resolve
  // before a slower one for event N, scrambling order in the browser.
  let eventChain: Promise<void> = Promise.resolve();
  state.client.onEvent((event) => {
    if (state.terminated) {
      return;
    }
    eventChain = eventChain.then(() => {
      return handleOpenAiEvent(state, event, browserSocket, repo, ctx);
    });
  });
  state.client.onError((error) => {
    fireAndForget(
      terminateError(state, browserSocket, repo, "openai_error", error.message),
    );
  });
  state.client.onClose((code, reason) => {
    if (state.terminated) {
      return;
    }
    fireAndForget(
      terminateError(
        state,
        browserSocket,
        repo,
        "closed_unexpectedly",
        `openai ws closed (code=${code} reason=${reason})`,
      ),
    );
  });
}

function wireBrowserSocket(
  state: InternalState,
  browserSocket: BrowserSocketLike,
  repo: RelaySessionRepository,
): void {
  browserSocket.onMessage((data) => {
    if (state.terminated) {
      return;
    }
    const parsed = parseBrowserEvent(data);
    if (!parsed.ok) {
      state.log.warn("rejecting browser event", {
        eventType: parsed.type ?? "<unknown>",
      });
      // Mark error first (sets terminated=true) so the subsequent
      // browserSocket.close() doesn't trigger terminateGracefully via the
      // onClose handler — terminateError must be the row's terminal state.
      // close is contractually no-throw on BrowserSocketLike.
      fireAndForget(
        terminateError(
          state,
          browserSocket,
          repo,
          "internal",
          "invalid browser event",
        ).then(() => {
          browserSocket.close(4400, "invalid browser event");
        }),
      );
      return;
    }
    forwardBrowserEvent(state, (parsed.event as BrowserEvent).raw);
  });
  browserSocket.onClose(() => {
    if (state.terminated) {
      return;
    }
    fireAndForget(terminateGracefully(state, browserSocket, repo, "graceful"));
  });
  browserSocket.onError((error) => {
    fireAndForget(
      terminateError(state, browserSocket, repo, "internal", error.message),
    );
  });
}

export async function runRelay(opts: RunRelayOptions): Promise<void> {
  const handlers = opts.handlers ?? NO_OP_PROVIDER_HANDLERS;
  const factory = opts.openAiClientFactory ?? createOpenAiRealtimeClient;

  const row = await opts.repo.insertStarting({
    voiceChatSessionId: opts.voiceChatSessionId,
    orgId: opts.orgId,
    userId: opts.userId,
    model: TALKER_MODEL,
    transcriptionModel: INPUT_AUDIO_TRANSCRIPTION_CONFIG.model,
  });

  const logCtx: RelayLogContext = {
    relaySessionId: row.id,
    voiceChatSessionId: opts.voiceChatSessionId,
    orgId: opts.orgId,
    userId: opts.userId,
  };
  const log = relayLogger(logCtx);

  const client = factory({
    url: opts.openAiUrl,
    apiKey: opts.openAiApiKey,
  });

  const state: InternalState = {
    relaySessionId: row.id,
    log,
    client,
    handlers,
    openaiSessionId: null,
    terminated: false,
  };

  const ctx: RelayContext = {
    relaySessionId: row.id,
    voiceChatSessionId: opts.voiceChatSessionId,
    orgId: opts.orgId,
    userId: opts.userId,
    sendToOpenAi: (event) => {
      client.send(event);
    },
    endRelay: () => {
      fireAndForget(
        terminateGracefully(
          state,
          opts.browserSocket,
          opts.repo,
          "session_ended",
        ),
      );
    },
  };

  wireOpenAiClient(state, opts.browserSocket, opts.repo, ctx);
  wireBrowserSocket(state, opts.browserSocket, opts.repo);

  if (opts.signal.aborted) {
    await terminateError(
      state,
      opts.browserSocket,
      opts.repo,
      "internal",
      "aborted before connect",
    );
    return;
  }
  opts.signal.addEventListener(
    "abort",
    () => {
      fireAndForget(terminateAborted(state, opts.browserSocket, opts.repo));
    },
    { once: true },
  );

  // `client.open()` resolves with the OpenAI session id or rejects with the
  // socket error. Convert the rejection into a terminal `error` row and a
  // browser-facing `relay.error` envelope; ignore the resolved value.
  await client.open({ instructions: opts.instructions }).then(
    () => {},
    (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "openai connect failed";
      return terminateError(
        state,
        opts.browserSocket,
        opts.repo,
        "openai_error",
        message,
      );
    },
  );
}

async function terminateGracefully(
  state: InternalState,
  browserSocket: BrowserSocketLike,
  repo: RelaySessionRepository,
  reason: "graceful" | "session_ended",
): Promise<void> {
  if (state.terminated) {
    return;
  }
  state.terminated = true;
  await repo.markEnded(state.relaySessionId);
  sendEnvelope(browserSocket, { type: "relay.closed", reason });
  state.client.close();
  // close is contractually no-throw on BrowserSocketLike.
  browserSocket.close();
  state.log.debug("relay ended", { eventType: reason });
}

async function terminateAborted(
  state: InternalState,
  browserSocket: BrowserSocketLike,
  repo: RelaySessionRepository,
): Promise<void> {
  if (state.terminated) {
    return;
  }
  state.terminated = true;
  await repo.markError(state.relaySessionId, "aborted");
  sendEnvelope(browserSocket, { type: "relay.closed", reason: "aborted" });
  state.client.close();
  browserSocket.close();
  state.log.warn("relay aborted");
}

async function terminateError(
  state: InternalState,
  browserSocket: BrowserSocketLike,
  repo: RelaySessionRepository,
  code: "openai_error" | "closed_unexpectedly" | "internal",
  message: string,
): Promise<void> {
  if (state.terminated) {
    return;
  }
  state.terminated = true;
  await repo.markError(state.relaySessionId, message);
  sendEnvelope(browserSocket, { type: "relay.error", code, message });
  state.client.close();
  browserSocket.close();
  state.log.error("relay error", { errorMessage: message });
}
