import { command, computed, state } from "ccstate";
import { z } from "zod";

import { now } from "../lib/time.ts";

const MAX_CONNECTION_DIAGNOSTIC_EVENTS = 500;
const CONNECTION_DIAGNOSTIC_EVENT = "vm0:connection-diagnostic";

// The Worker publishes its own capture over the shared database bridge, so the
// diagnostics shape is a wire format and Zod owns it.
const connectionDiagnosticEventNameSchema = z.enum([
  "foreground.catch-up",
  "foreground.request",
  "foreground.skipped",
  "foreground.subscriber-catch-up",
  "foreground.visibility-wait",
  "lifecycle.blur",
  "lifecycle.focus",
  "lifecycle.network",
  "lifecycle.snapshot",
  "lifecycle.visibility",
  "realtime.auth-callback",
  "realtime.channel",
  "realtime.channel-replace",
  "realtime.client",
  "realtime.client-rebuild",
  "realtime.connection",
  "realtime.initial-connection",
  "realtime.pending-subscribers",
  "realtime.subscriber-catch-up",
  "realtime.subscription",
]);

export type ConnectionDiagnosticEventName = z.infer<
  typeof connectionDiagnosticEventNameSchema
>;

const connectionDiagnosticPhaseSchema = z.enum([
  "error",
  "finish",
  "instant",
  "join",
  "start",
]);

type ConnectionDiagnosticPhase = z.infer<
  typeof connectionDiagnosticPhaseSchema
>;

const connectionDiagnosticConnectionStateSchema = z.enum([
  "closed",
  "closing",
  "connected",
  "connecting",
  "disconnected",
  "failed",
  "initialized",
  "suspended",
]);

export type ConnectionDiagnosticConnectionState = z.infer<
  typeof connectionDiagnosticConnectionStateSchema
>;

const connectionDiagnosticChannelStateSchema = z.enum([
  "attached",
  "attaching",
  "detached",
  "detaching",
  "failed",
  "initialized",
  "suspended",
]);

export type ConnectionDiagnosticChannelState = z.infer<
  typeof connectionDiagnosticChannelStateSchema
>;

const visibilityStateSchema = z.enum(["hidden", "visible"]);

const connectionDiagnosticDetailsSchema = z
  .object({
    channelState: connectionDiagnosticChannelStateSchema.optional(),
    connectionState: connectionDiagnosticConnectionStateSchema.optional(),
    errorCode: z.union([z.number(), z.string()]).optional(),
    errorMessage: z.string().optional(),
    focused: z.boolean().optional(),
    online: z.boolean().optional(),
    pendingSubscriberCount: z.number().optional(),
    previousChannelState: connectionDiagnosticChannelStateSchema.optional(),
    previousConnectionState:
      connectionDiagnosticConnectionStateSchema.optional(),
    retryInMs: z.number().optional(),
    skipReason: z.enum(["hidden", "no-realtime-session"]).optional(),
    statusCode: z.number().optional(),
    subscriberCount: z.number().optional(),
    subscriptionKind: z.enum(["channel", "payload", "topic"]).optional(),
    tokenAvailable: z.boolean().optional(),
    trigger: z
      .enum([
        "blur",
        "focus",
        "initial",
        "offline",
        "online",
        "realtime-connected",
        "visibilitychange",
      ])
      .optional(),
    visibilityState: visibilityStateSchema.optional(),
  })
  .strict()
  .readonly();

export type ConnectionDiagnosticDetails = z.infer<
  typeof connectionDiagnosticDetailsSchema
>;

interface ConnectionDiagnosticInput {
  readonly details?: ConnectionDiagnosticDetails;
  readonly durationMs?: number;
  readonly event: ConnectionDiagnosticEventName;
  readonly phase: ConnectionDiagnosticPhase;
  readonly spanId?: string;
}

const connectionDiagnosticEventSchema = z
  .object({
    details: connectionDiagnosticDetailsSchema.optional(),
    durationMs: z.number().optional(),
    elapsedMs: z.number(),
    event: connectionDiagnosticEventNameSchema,
    phase: connectionDiagnosticPhaseSchema,
    sequence: z.number(),
    spanId: z.string().optional(),
    timestamp: z.string(),
    timestampMs: z.number(),
  })
  .strict()
  .readonly();

export type ConnectionDiagnosticEvent = z.infer<
  typeof connectionDiagnosticEventSchema
>;

interface ConnectionDiagnosticState {
  readonly captureStartedAtMs: number | null;
  readonly enabled: boolean;
  readonly events: readonly ConnectionDiagnosticEvent[];
  readonly nextSequence: number;
}

const activeConnectionDiagnosticWaitSchema = z
  .object({
    event: connectionDiagnosticEventNameSchema,
    spanId: z.string(),
    startedAtMs: z.number(),
  })
  .strict()
  .readonly();

export type ActiveConnectionDiagnosticWait = z.infer<
  typeof activeConnectionDiagnosticWaitSchema
>;

export const connectionDiagnosticsSchema = z
  .object({
    activeWaits: activeConnectionDiagnosticWaitSchema.array().readonly(),
    capacity: z.number(),
    captureStartedAt: z.string().nullable(),
    enabled: z.boolean(),
    events: connectionDiagnosticEventSchema.array().readonly(),
    snapshot: z
      .object({
        channelState: connectionDiagnosticChannelStateSchema.nullable(),
        connectionState: connectionDiagnosticConnectionStateSchema.nullable(),
        focused: z.boolean(),
        online: z.boolean(),
        recoveryPhase: z.union([
          connectionDiagnosticEventNameSchema,
          z.literal("idle"),
        ]),
        visibilityState: visibilityStateSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type ConnectionDiagnostics = z.infer<typeof connectionDiagnosticsSchema>;

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
  // `globalThis` is an EventTarget in both the page and the SharedWorker, so
  // the capture path needs no DOM global and no runtime branch.
  globalThis.dispatchEvent(
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
    const handleDiagnosticEvent = (event: Event): void => {
      const diagnosticEvent = event as CustomEvent<ConnectionDiagnosticInput>;
      set(writeConnectionDiagnostic$, {
        action: "append",
        event: diagnosticEvent.detail,
      });
    };
    globalThis.addEventListener(
      CONNECTION_DIAGNOSTIC_EVENT,
      handleDiagnosticEvent,
      { signal },
    );
  },
);

/** Browser lifecycle signals that only a page can observe. */
export const setupBrowserLifecycleDiagnostics$ = command(
  (_ctx, signal: AbortSignal): void => {
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
