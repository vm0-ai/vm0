/** Foreground catch-up coordination for realtime-backed data. */
import { command, computed, state, type Command } from "ccstate";
import { now } from "../lib/time.ts";
import {
  connectionDiagnosticError,
  createConnectionDiagnosticSpanId,
  publishConnectionDiagnostic,
} from "./connection-diagnostics.ts";
import {
  createDeferredPromise,
  onDomEventFn,
  setLoop,
  settle,
  withCleanup,
} from "./utils";

function runtimeVisibilityState(): DocumentVisibilityState {
  return typeof document === "undefined"
    ? "visible"
    : globalThis.document.visibilityState;
}

const FOREGROUND_CATCH_UP_REQUEST_EVENT = "request-catch-up";

const foregroundCatchUpTarget$ = state(new EventTarget());
type ForegroundCatchUpCommand = Command<Promise<void> | void, [AbortSignal]>;
const foregroundCatchUpCommands$ = state<ReadonlySet<ForegroundCatchUpCommand>>(
  new Set(),
);

interface ForegroundReady {
  readonly pending: boolean;
  readonly promise: Promise<void>;
}

function settledForegroundReady(): ForegroundReady {
  return { pending: false, promise: Promise.resolve() };
}

const foregroundReadyState$ = state<ForegroundReady>(settledForegroundReady());

/**
 * Shared barrier for work that must not confirm remote state while the app is
 * hidden or foreground subscribers are still catching up.
 */
export const foregroundReady$ = computed((get) => {
  return get(foregroundReadyState$);
});

export const subscribeForegroundCatchUp$ = command(
  ({ get, set }, callback$: ForegroundCatchUpCommand, signal: AbortSignal) => {
    set(
      foregroundCatchUpCommands$,
      new Set([...get(foregroundCatchUpCommands$), callback$]),
    );
    signal.addEventListener(
      "abort",
      () => {
        const commands = new Set(get(foregroundCatchUpCommands$));
        commands.delete(callback$);
        set(foregroundCatchUpCommands$, commands);
      },
      { once: true },
    );
  },
);

const runForegroundCatchUp$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await Promise.all(
      [...get(foregroundCatchUpCommands$)].map(async (callback$) => {
        await set(callback$, signal);
        signal.throwIfAborted();
      }),
    );
    signal.throwIfAborted();
  },
);

interface TrackedForegroundCatchUpArgs {
  readonly spanId: string;
  readonly startedAtMs: number;
  readonly subscriberCount: number;
}

const runTrackedForegroundCatchUp$ = command(
  async (
    { set },
    { spanId, startedAtMs, subscriberCount }: TrackedForegroundCatchUpArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const catchUpResult = await settle(
      (async () => {
        if (runtimeVisibilityState() !== "visible") {
          publishConnectionDiagnostic({
            details: {
              skipReason: "hidden",
              visibilityState: runtimeVisibilityState(),
            },
            event: "foreground.skipped",
            phase: "instant",
          });
          return;
        }

        const subscriberSpanId = createConnectionDiagnosticSpanId();
        const subscribersStartedAtMs = now();
        publishConnectionDiagnostic({
          details: { subscriberCount },
          event: "foreground.subscriber-catch-up",
          phase: "start",
          spanId: subscriberSpanId,
        });
        const subscribersResult = await settle(
          set(runForegroundCatchUp$, signal),
          signal,
        );
        if (!subscribersResult.ok) {
          publishConnectionDiagnostic({
            details: {
              ...connectionDiagnosticError(subscribersResult.error),
              subscriberCount,
            },
            durationMs: now() - subscribersStartedAtMs,
            event: "foreground.subscriber-catch-up",
            phase: "error",
            spanId: subscriberSpanId,
          });
          throw subscribersResult.error;
        }
        publishConnectionDiagnostic({
          details: { subscriberCount },
          durationMs: now() - subscribersStartedAtMs,
          event: "foreground.subscriber-catch-up",
          phase: "finish",
          spanId: subscriberSpanId,
        });
      })(),
      signal,
    );

    if (!catchUpResult.ok) {
      publishConnectionDiagnostic({
        details: connectionDiagnosticError(catchUpResult.error),
        durationMs: now() - startedAtMs,
        event: "foreground.catch-up",
        phase: "error",
        spanId,
      });
      throw catchUpResult.error;
    }
    publishConnectionDiagnostic({
      durationMs: now() - startedAtMs,
      event: "foreground.catch-up",
      phase: "finish",
      spanId,
    });
  },
);

type ForegroundRequestTrigger =
  | "focus"
  | "online"
  | "realtime-connected"
  | "visibilitychange";

function publishForegroundRequest(
  trigger: ForegroundRequestTrigger,
  skipReason?: "hidden",
): void {
  publishConnectionDiagnostic({
    details: {
      skipReason,
      trigger,
      visibilityState: runtimeVisibilityState(),
    },
    event: "foreground.request",
    phase: "instant",
  });
}

export const requestForegroundCatchUp$ = command(({ get }) => {
  if (runtimeVisibilityState() !== "visible") {
    publishForegroundRequest("realtime-connected", "hidden");
    return;
  }
  publishForegroundRequest("realtime-connected");
  get(foregroundCatchUpTarget$).dispatchEvent(
    new Event(FOREGROUND_CATCH_UP_REQUEST_EVENT),
  );
});

function setupForegroundRequestListeners(
  catchUpTarget: EventTarget,
  blockUntilForeground: () => void,
  signal: AbortSignal,
): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  const handleVisibilityChange = (): void => {
    if (runtimeVisibilityState() !== "visible") {
      blockUntilForeground();
      return;
    }
    publishForegroundRequest("visibilitychange");
    catchUpTarget.dispatchEvent(new Event(FOREGROUND_CATCH_UP_REQUEST_EVENT));
  };
  const requestCatchUp = (trigger: "focus" | "online"): void => {
    if (runtimeVisibilityState() === "visible") {
      publishForegroundRequest(trigger);
      catchUpTarget.dispatchEvent(new Event(FOREGROUND_CATCH_UP_REQUEST_EVENT));
    }
  };
  globalThis.document.addEventListener(
    "visibilitychange",
    handleVisibilityChange,
    {
      signal,
    },
  );
  globalThis.window.addEventListener(
    "focus",
    () => {
      requestCatchUp("focus");
    },
    { signal },
  );
  globalThis.window.addEventListener(
    "online",
    () => {
      requestCatchUp("online");
    },
    { signal },
  );
}

/**
 * Route visibility, focus, network restoration, and realtime reconnect through
 * one catch-up task.
 */
export const setupForegroundCatchUp$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    const catchUpTarget = get(foregroundCatchUpTarget$);
    let catchUpPromise: Promise<void> | null = null;
    let requestedVisibilityRevision = 0;
    let visibilityRevision = 0;
    let catchUpSpanId: string | null = null;
    let hiddenReady: ReturnType<typeof createDeferredPromise<void>> | null =
      null;
    let hiddenReadyStartedAtMs: number | null = null;
    let hiddenReadySpanId: string | null = null;

    const blockUntilForeground = (): void => {
      if (!hiddenReady || hiddenReady.settled()) {
        hiddenReady = createDeferredPromise<void>(signal);
        hiddenReadySpanId = createConnectionDiagnosticSpanId();
        hiddenReadyStartedAtMs = now();
        publishConnectionDiagnostic({
          details: { visibilityState: runtimeVisibilityState() },
          event: "foreground.visibility-wait",
          phase: "start",
          spanId: hiddenReadySpanId,
        });
      }
      set(foregroundReadyState$, {
        pending: true,
        promise: hiddenReady.promise,
      });
    };

    const markForegroundReady = (): void => {
      if (runtimeVisibilityState() !== "visible") {
        blockUntilForeground();
        return;
      }
      if (hiddenReady && !hiddenReady.settled()) {
        hiddenReady.resolve();
      }
      if (hiddenReadySpanId !== null && hiddenReadyStartedAtMs !== null) {
        publishConnectionDiagnostic({
          details: { visibilityState: runtimeVisibilityState() },
          durationMs: now() - hiddenReadyStartedAtMs,
          event: "foreground.visibility-wait",
          phase: "finish",
          spanId: hiddenReadySpanId,
        });
      }
      hiddenReady = null;
      hiddenReadySpanId = null;
      hiddenReadyStartedAtMs = null;
      set(foregroundReadyState$, settledForegroundReady());
    };

    if (runtimeVisibilityState() === "visible") {
      markForegroundReady();
    } else {
      blockUntilForeground();
    }

    const runRequestedCatchUps = async (): Promise<void> => {
      await setLoop(
        async (loopSignal) => {
          const requestRevision = requestedVisibilityRevision;
          const spanId = createConnectionDiagnosticSpanId();
          const startedAtMs = now();
          catchUpSpanId = spanId;
          publishConnectionDiagnostic({
            event: "foreground.catch-up",
            phase: "start",
            spanId,
          });
          await set(
            runTrackedForegroundCatchUp$,
            {
              spanId,
              startedAtMs,
              subscriberCount: get(foregroundCatchUpCommands$).size,
            },
            loopSignal,
          );
          loopSignal.throwIfAborted();

          return (
            requestRevision === requestedVisibilityRevision ||
            runtimeVisibilityState() !== "visible"
          );
        },
        0,
        signal,
        { retryTransientErrors: false },
      );
    };

    const catchUpForeground = (): Promise<void> => {
      requestedVisibilityRevision = visibilityRevision;
      if (!catchUpPromise) {
        const catchUp = withCleanup(runRequestedCatchUps(), () => {
          if (catchUpPromise === catchUp) {
            catchUpPromise = null;
            catchUpSpanId = null;
          }
          markForegroundReady();
        });
        catchUpPromise = catchUp;
        set(foregroundReadyState$, { pending: true, promise: catchUp });
      } else if (catchUpSpanId !== null) {
        publishConnectionDiagnostic({
          event: "foreground.catch-up",
          phase: "join",
          spanId: catchUpSpanId,
        });
      }
      return catchUpPromise;
    };

    catchUpTarget.addEventListener(
      FOREGROUND_CATCH_UP_REQUEST_EVENT,
      onDomEventFn(async () => {
        await catchUpForeground();
      }),
      { signal },
    );

    setupForegroundRequestListeners(
      catchUpTarget,
      () => {
        visibilityRevision += 1;
        blockUntilForeground();
      },
      signal,
    );
  },
);
