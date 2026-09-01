import { command, computed, state } from "ccstate";

import { now } from "../lib/time.ts";

const MAX_CONNECTION_DIAGNOSTIC_EVENTS = 500;
const CONNECTION_DIAGNOSTIC_EVENT = "vm0:connection-diagnostic";

export type ConnectionDiagnosticEventName =
  | "foreground.catch-up"
  | "foreground.request"
  | "foreground.skipped"
  | "foreground.subscriber-catch-up"
  | "foreground.visibility-wait"
  | "lifecycle.blur"
  | "lifecycle.focus"
  | "lifecycle.network"
  | "lifecycle.snapshot"
  | "lifecycle.visibility"
  | "realtime.auth-callback"
  | "realtime.channel"
  | "realtime.channel-replace"
  | "realtime.client"
  | "realtime.client-rebuild"
  | "realtime.connection"
  | "realtime.initial-connection"
  | "realtime.pending-subscribers"
  | "realtime.subscriber-catch-up"
  | "realtime.subscription";

type ConnectionDiagnosticPhase =
  | "error"
  | "finish"
  | "instant"
  | "join"
  | "start";

export type ConnectionDiagnosticConnectionState =
  | "closed"
  | "closing"
  | "connected"
  | "connecting"
  | "disconnected"
  | "failed"
  | "initialized"
  | "suspended";

export type ConnectionDiagnosticChannelState =
  | "attached"
  | "attaching"
  | "detached"
  | "detaching"
  | "failed"
  | "initialized"
  | "suspended";

export interface ConnectionDiagnosticDetails {
  readonly channelState?: ConnectionDiagnosticChannelState;
  readonly connectionState?: ConnectionDiagnosticConnectionState;
  readonly errorCode?: number | string;
  readonly errorMessage?: string;
  readonly focused?: boolean;
  readonly online?: boolean;
  readonly pendingSubscriberCount?: number;
  readonly previousChannelState?: ConnectionDiagnosticChannelState;
  readonly previousConnectionState?: ConnectionDiagnosticConnectionState;
  readonly retryInMs?: number;
  readonly skipReason?: "hidden" | "no-realtime-session";
  readonly statusCode?: number;
  readonly subscriberCount?: number;
  readonly subscriptionKind?: "channel" | "payload" | "topic";
  readonly tokenAvailable?: boolean;
  readonly trigger?:
    | "blur"
    | "focus"
    | "initial"
    | "offline"
    | "online"
    | "realtime-connected"
    | "visibilitychange";
  readonly visibilityState?: DocumentVisibilityState;
}

interface ConnectionDiagnosticInput {
  readonly details?: ConnectionDiagnosticDetails;
  readonly durationMs?: number;
  readonly event: ConnectionDiagnosticEventName;
  readonly phase: ConnectionDiagnosticPhase;
  readonly spanId?: string;
}

export interface ConnectionDiagnosticEvent extends ConnectionDiagnosticInput {
  readonly elapsedMs: number;
  readonly sequence: number;
  readonly timestamp: string;
  readonly timestampMs: number;
}

interface ConnectionDiagnosticState {
  readonly captureStartedAtMs: number | null;
  readonly enabled: boolean;
  readonly events: readonly ConnectionDiagnosticEvent[];
  readonly nextSequence: number;
}

export interface ActiveConnectionDiagnosticWait {
  readonly event: ConnectionDiagnosticEventName;
  readonly spanId: string;
  readonly startedAtMs: number;
}

export interface ConnectionDiagnostics {
  readonly activeWaits: readonly ActiveConnectionDiagnosticWait[];
  readonly capacity: number;
  readonly captureStartedAt: string | null;
  readonly enabled: boolean;
  readonly events: readonly ConnectionDiagnosticEvent[];
  readonly snapshot: {
    readonly channelState: ConnectionDiagnosticChannelState | null;
    readonly connectionState: ConnectionDiagnosticConnectionState | null;
    readonly focused: boolean;
    readonly online: boolean;
    readonly recoveryPhase: ConnectionDiagnosticEventName | "idle";
    readonly visibilityState: DocumentVisibilityState;
  };
}

type ConnectionDiagnosticWrite =
  | { readonly action: "append"; readonly event: ConnectionDiagnosticInput }
  | { readonly action: "clear" }
  | { readonly action: "set-enabled"; readonly enabled: boolean };

const connectionDiagnosticState$ = state<ConnectionDiagnosticState>({
  captureStartedAtMs: null,
  enabled: false,
  events: [],
  nextSequence: 1,
});

function runtimeBrowserState(): {
  readonly focused: boolean;
  readonly online: boolean;
  readonly visibilityState: DocumentVisibilityState;
} {
  return {
    focused:
      typeof document === "undefined" ? true : globalThis.document.hasFocus(),
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    visibilityState:
      typeof document === "undefined"
        ? "visible"
        : globalThis.document.visibilityState,
  };
}

function browserDetails(
  trigger: NonNullable<ConnectionDiagnosticDetails["trigger"]>,
): ConnectionDiagnosticDetails {
  const state = runtimeBrowserState();
  return {
    focused: state.focused,
    online: state.online,
    trigger,
    visibilityState: state.visibilityState,
  };
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[url]")
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/giu, "[id]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      "[id]",
    )
    .replace(/\b(?:org|run|session|thread|user)_[a-z0-9_-]+\b/giu, "[id]")
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/giu, "[token]")
    .replace(/\b[a-z0-9_-]{32,}\b/giu, "[redacted]")
    .slice(0, 400);
}

function sanitizeDiagnosticDetails(
  details: ConnectionDiagnosticDetails | undefined,
): ConnectionDiagnosticDetails | undefined {
  if (!details) {
    return undefined;
  }
  return {
    channelState: details.channelState,
    connectionState: details.connectionState,
    errorCode:
      typeof details.errorCode === "string"
        ? sanitizeDiagnosticText(details.errorCode)
        : details.errorCode,
    errorMessage:
      details.errorMessage === undefined
        ? undefined
        : sanitizeDiagnosticText(details.errorMessage),
    focused: details.focused,
    online: details.online,
    pendingSubscriberCount: details.pendingSubscriberCount,
    previousChannelState: details.previousChannelState,
    previousConnectionState: details.previousConnectionState,
    retryInMs: details.retryInMs,
    skipReason: details.skipReason,
    statusCode: details.statusCode,
    subscriberCount: details.subscriberCount,
    subscriptionKind: details.subscriptionKind,
    tokenAvailable: details.tokenAvailable,
    trigger: details.trigger,
    visibilityState: details.visibilityState,
  };
}

function appendDiagnosticEvent(
  current: ConnectionDiagnosticState,
  input: ConnectionDiagnosticInput,
): ConnectionDiagnosticState {
  if (!current.enabled || current.captureStartedAtMs === null) {
    return current;
  }

  const timestampMs = now();
  const event: ConnectionDiagnosticEvent = {
    ...input,
    details: sanitizeDiagnosticDetails(input.details),
    elapsedMs: Math.max(0, timestampMs - current.captureStartedAtMs),
    sequence: current.nextSequence,
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
  };
  const events = [...current.events, event].slice(
    -MAX_CONNECTION_DIAGNOSTIC_EVENTS,
  );
  return {
    ...current,
    events,
    nextSequence: current.nextSequence + 1,
  };
}

export const writeConnectionDiagnostic$ = command(
  ({ get, set }, write: ConnectionDiagnosticWrite): void => {
    const current = get(connectionDiagnosticState$);
    if (write.action === "clear") {
      set(connectionDiagnosticState$, {
        captureStartedAtMs: current.enabled ? now() : null,
        enabled: current.enabled,
        events: [],
        nextSequence: 1,
      });
      return;
    }
    if (write.action === "set-enabled") {
      if (write.enabled === current.enabled) {
        return;
      }
      if (!write.enabled) {
        set(connectionDiagnosticState$, {
          captureStartedAtMs: null,
          enabled: false,
          events: [],
          nextSequence: 1,
        });
        return;
      }

      const enabledState: ConnectionDiagnosticState = {
        captureStartedAtMs: now(),
        enabled: true,
        events: [],
        nextSequence: 1,
      };
      set(
        connectionDiagnosticState$,
        appendDiagnosticEvent(enabledState, {
          details: browserDetails("initial"),
          event: "lifecycle.snapshot",
          phase: "instant",
        }),
      );
      return;
    }

    set(
      connectionDiagnosticState$,
      appendDiagnosticEvent(current, write.event),
    );
  },
);

function latestConnectionStates(events: readonly ConnectionDiagnosticEvent[]): {
  readonly channelState: ConnectionDiagnosticChannelState | null;
  readonly connectionState: ConnectionDiagnosticConnectionState | null;
} {
  let channelState: ConnectionDiagnosticChannelState | null = null;
  let connectionState: ConnectionDiagnosticConnectionState | null = null;
  for (const event of events) {
    channelState = event.details?.channelState ?? channelState;
    connectionState = event.details?.connectionState ?? connectionState;
  }
  return { channelState, connectionState };
}

function activeDiagnosticWaits(
  events: readonly ConnectionDiagnosticEvent[],
): readonly ActiveConnectionDiagnosticWait[] {
  const active = new Map<string, ActiveConnectionDiagnosticWait>();
  for (const event of events) {
    if (event.spanId === undefined) {
      continue;
    }
    if (event.phase === "start") {
      active.set(event.spanId, {
        event: event.event,
        spanId: event.spanId,
        startedAtMs: event.timestampMs,
      });
    } else if (event.phase === "error" || event.phase === "finish") {
      active.delete(event.spanId);
    }
  }
  return [...active.values()];
}

export const connectionDiagnostics$ = computed((get): ConnectionDiagnostics => {
  const current = get(connectionDiagnosticState$);
  const activeWaits = activeDiagnosticWaits(current.events);
  const states = latestConnectionStates(current.events);
  const browserState = runtimeBrowserState();
  return {
    activeWaits,
    capacity: MAX_CONNECTION_DIAGNOSTIC_EVENTS,
    captureStartedAt:
      current.captureStartedAtMs === null
        ? null
        : new Date(current.captureStartedAtMs).toISOString(),
    enabled: current.enabled,
    events: current.events,
    snapshot: {
      ...states,
      focused: browserState.focused,
      online: browserState.online,
      recoveryPhase: activeWaits.at(-1)?.event ?? "idle",
      visibilityState: browserState.visibilityState,
    },
  };
});

export function publishConnectionDiagnostic(
  event: ConnectionDiagnosticInput,
): void {
  if (typeof window === "undefined") {
    return;
  }
  globalThis.window.dispatchEvent(
    new CustomEvent<ConnectionDiagnosticInput>(CONNECTION_DIAGNOSTIC_EVENT, {
      detail: event,
    }),
  );
}

export function createConnectionDiagnosticSpanId(): string {
  return crypto.getRandomValues(new Uint32Array(2)).join("-");
}

export function connectionDiagnosticError(
  error: unknown,
): Pick<
  ConnectionDiagnosticDetails,
  "errorCode" | "errorMessage" | "retryInMs" | "statusCode"
> {
  if (typeof error === "string") {
    return { errorMessage: sanitizeDiagnosticText(error) };
  }
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const errorMessage =
    "message" in error && typeof error.message === "string"
      ? sanitizeDiagnosticText(error.message)
      : undefined;
  const errorCode =
    "code" in error &&
    (typeof error.code === "number" || typeof error.code === "string")
      ? error.code
      : undefined;
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : "status" in error && typeof error.status === "number"
        ? error.status
        : undefined;
  const retryInMs =
    "retryIn" in error && typeof error.retryIn === "number"
      ? error.retryIn
      : undefined;
  return { errorCode, errorMessage, retryInMs, statusCode };
}

export const setupConnectionDiagnostics$ = command(
  ({ set }, signal: AbortSignal): void => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const handleDiagnosticEvent = (event: Event): void => {
      const diagnosticEvent = event as CustomEvent<ConnectionDiagnosticInput>;
      set(writeConnectionDiagnostic$, {
        action: "append",
        event: diagnosticEvent.detail,
      });
    };
    globalThis.window.addEventListener(
      CONNECTION_DIAGNOSTIC_EVENT,
      handleDiagnosticEvent,
      {
        signal,
      },
    );

    globalThis.document.addEventListener(
      "visibilitychange",
      () => {
        publishConnectionDiagnostic({
          details: browserDetails("visibilitychange"),
          event: "lifecycle.visibility",
          phase: "instant",
        });
      },
      { signal },
    );
    globalThis.window.addEventListener(
      "focus",
      () => {
        publishConnectionDiagnostic({
          details: browserDetails("focus"),
          event: "lifecycle.focus",
          phase: "instant",
        });
      },
      { signal },
    );
    globalThis.window.addEventListener(
      "blur",
      () => {
        publishConnectionDiagnostic({
          details: browserDetails("blur"),
          event: "lifecycle.blur",
          phase: "instant",
        });
      },
      { signal },
    );
    globalThis.window.addEventListener(
      "online",
      () => {
        publishConnectionDiagnostic({
          details: browserDetails("online"),
          event: "lifecycle.network",
          phase: "instant",
        });
      },
      { signal },
    );
    globalThis.window.addEventListener(
      "offline",
      () => {
        publishConnectionDiagnostic({
          details: browserDetails("offline"),
          event: "lifecycle.network",
          phase: "instant",
        });
      },
      { signal },
    );
  },
);
