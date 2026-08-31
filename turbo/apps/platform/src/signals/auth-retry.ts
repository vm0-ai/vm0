/**
 * Token access and 401 recovery for authenticated requests.
 *
 * Forced refreshes are root-owned and shared. Request cancellation stops only
 * that request from waiting; it does not interrupt a refresh used by the rest
 * of the app.
 */
import { command, computed, state, type Command } from "ccstate";
import type { BrowserClerk as Clerk } from "@clerk/shared/types";
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

type ClerkLike = Pick<Clerk, "session" | "addListener">;

function runtimeVisibilityState(): DocumentVisibilityState {
  return typeof document === "undefined"
    ? "visible"
    : globalThis.document.visibilityState;
}

export interface AuthRecovery {
  readonly getToken: (signal: AbortSignal) => Promise<string | null>;
  readonly forceRefreshToken: (signal: AbortSignal) => Promise<string | null>;
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

/**
 * Create the single auth-recovery owner for the current Clerk/root lifecycle.
 */
export function createAuthRecovery(
  clerk: ClerkLike,
  rootSignal: AbortSignal,
): AuthRecovery {
  let forceRefreshPromise: Promise<string | null> | null = null;
  let forceRefreshSpanId: string | null = null;

  const forceRefreshToken = (signal: AbortSignal): Promise<string | null> => {
    if (!forceRefreshPromise) {
      const spanId = createConnectionDiagnosticSpanId();
      const startedAtMs = now();
      publishConnectionDiagnostic({
        event: "auth.refresh",
        phase: "start",
        spanId,
      });
      const refresh = withCleanup(
        runTrackedForceRefresh(clerk, rootSignal, spanId, startedAtMs),
        () => {
          if (forceRefreshPromise === refresh) {
            forceRefreshPromise = null;
            forceRefreshSpanId = null;
          }
        },
      );
      forceRefreshPromise = refresh;
      forceRefreshSpanId = spanId;
    } else if (forceRefreshSpanId !== null) {
      publishConnectionDiagnostic({
        event: "auth.refresh",
        phase: "join",
        spanId: forceRefreshSpanId,
      });
    }
    return waitForAuthRecovery(forceRefreshPromise, signal);
  };

  return {
    getToken: (signal: AbortSignal) => {
      if (forceRefreshPromise) {
        return waitForAuthRecovery(forceRefreshPromise, signal);
      }
      const session = clerk.session;
      if (session !== undefined) {
        return readSettledClerkToken(session, signal);
      }
      const tokenSignal = AbortSignal.any([rootSignal, signal]);
      return readToken(clerk, tokenSignal);
    },
    forceRefreshToken,
  };
}

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

type SettledClerkSession = Exclude<Clerk["session"], undefined>;
async function runTrackedForceRefresh(
  clerk: ClerkLike,
  signal: AbortSignal,
  spanId: string,
  startedAtMs: number,
): Promise<string | null> {
  const result = await settle(forceRefreshClerkToken(clerk, signal), signal);
  if (!result.ok) {
    publishConnectionDiagnostic({
      details: connectionDiagnosticError(result.error),
      durationMs: now() - startedAtMs,
      event: "auth.refresh",
      phase: "error",
      spanId,
    });
    throw result.error;
  }
  publishConnectionDiagnostic({
    details: { tokenAvailable: result.value !== null },
    durationMs: now() - startedAtMs,
    event: "auth.refresh",
    phase: "finish",
    spanId,
  });
  return result.value;
}

function waitForSettledClerkSession(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<SettledClerkSession> {
  signal.throwIfAborted();

  if (clerk.session !== undefined) {
    return Promise.resolve(clerk.session);
  }

  const deferred = createDeferredPromise<SettledClerkSession>(signal);
  const resolveIfSettled = (session: Clerk["session"]): void => {
    if (session === undefined) {
      return;
    }
    signal.removeEventListener("abort", unsubscribe);
    unsubscribe();
    deferred.resolve(session);
  };
  const unsubscribe = clerk.addListener(
    ({ session }) => {
      resolveIfSettled(session);
    },
    { skipInitialEmit: true },
  );
  signal.addEventListener("abort", unsubscribe, { once: true });

  // Close the race between the initial read and listener registration.
  resolveIfSettled(clerk.session);

  return deferred.promise;
}

async function forceRefreshClerkToken(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<string | null> {
  const session = await waitForSettledClerkSession(clerk, signal);
  if (session === null) {
    return null;
  }
  return await waitForAuthRecovery(
    session.getToken({ skipCache: true }),
    signal,
  );
}

async function readToken(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<string | null> {
  const session = await waitForSettledClerkSession(clerk, signal);
  return await readSettledClerkToken(session, signal);
}

async function readSettledClerkToken(
  session: SettledClerkSession,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  if (session === null) {
    return null;
  }
  return await waitForAuthRecovery(session.getToken(), signal);
}

function waitForAuthRecovery<T>(
  recovery: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  return withCleanup(Promise.race([recovery, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(new DOMException("Auth recovery settled", "AbortError"));
    }
  });
}
