/**
 * Auth recovery shared by foreground catch-up and authenticated requests.
 *
 * Every recovery trigger joins the same root-owned Clerk refresh. Request
 * cancellation stops only that request from waiting; it does not interrupt the
 * shared refresh used by the rest of the app.
 */
import { command, computed, state, type Command } from "ccstate";
import type { Clerk } from "@clerk/clerk-js";
import { isNetworkRequestError } from "../lib/network-error.ts";
import { now } from "../lib/time.ts";
import {
  connectionDiagnosticError,
  createConnectionDiagnosticSpanId,
  publishConnectionDiagnostic,
  type ConnectionDiagnosticEventName,
} from "./connection-diagnostics.ts";
import {
  createDeferredPromise,
  onDomEventFn,
  retryWithFibonacciBackoff,
  settle,
  withCleanup,
} from "./utils";

type ClerkLike = Pick<Clerk, "session" | "addListener">;

export interface AuthRecovery {
  readonly getToken: (signal?: AbortSignal) => Promise<string | null>;
  readonly refreshAuth: (signal?: AbortSignal) => Promise<string | null>;
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
 * hidden or Clerk is still recovering the foreground session.
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
  readonly authRecovery: AuthRecovery;
  readonly spanId: string;
  readonly startedAtMs: number;
  readonly subscriberCount: number;
}

const runTrackedForegroundCatchUp$ = command(
  async (
    { set },
    {
      authRecovery,
      spanId,
      startedAtMs,
      subscriberCount,
    }: TrackedForegroundCatchUpArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const catchUpResult = await settle(
      (async () => {
        const authSpanId = createConnectionDiagnosticSpanId();
        const authStartedAtMs = now();
        publishConnectionDiagnostic({
          event: "foreground.auth-refresh",
          phase: "start",
          spanId: authSpanId,
        });
        const authResult = await settle(
          authRecovery.refreshAuth(signal),
          signal,
        );
        if (!authResult.ok) {
          publishConnectionDiagnostic({
            details: connectionDiagnosticError(authResult.error),
            durationMs: now() - authStartedAtMs,
            event: "foreground.auth-refresh",
            phase: "error",
            spanId: authSpanId,
          });
          throw authResult.error;
        }
        publishConnectionDiagnostic({
          details: { tokenAvailable: authResult.value !== null },
          durationMs: now() - authStartedAtMs,
          event: "foreground.auth-refresh",
          phase: "finish",
          spanId: authSpanId,
        });

        if (
          authResult.value === null ||
          document.visibilityState !== "visible"
        ) {
          publishConnectionDiagnostic({
            details: {
              skipReason:
                authResult.value === null ? "missing-token" : "hidden",
              visibilityState: document.visibilityState,
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
      visibilityState: document.visibilityState,
    },
    event: "foreground.request",
    phase: "instant",
  });
}

export const requestForegroundCatchUp$ = command(({ get }) => {
  if (document.visibilityState !== "visible") {
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
  getRootSignal: () => AbortSignal,
): AuthRecovery {
  let refreshPromise: Promise<string | null> | null = null;
  let refreshSpanId: string | null = null;

  const refreshAuth = (signal?: AbortSignal): Promise<string | null> => {
    if (!refreshPromise) {
      const rootSignal = getRootSignal();
      const spanId = createConnectionDiagnosticSpanId();
      const startedAtMs = now();
      publishConnectionDiagnostic({
        event: "auth.refresh",
        phase: "start",
        spanId,
      });
      const refresh = withCleanup(
        runTrackedAuthRefresh(clerk, rootSignal, spanId, startedAtMs),
        () => {
          if (refreshPromise === refresh) {
            refreshPromise = null;
            refreshSpanId = null;
          }
        },
      );
      refreshPromise = refresh;
      refreshSpanId = spanId;
    } else if (refreshSpanId !== null) {
      publishConnectionDiagnostic({
        event: "auth.refresh",
        phase: "join",
        spanId: refreshSpanId,
      });
    }
    return waitForAuthRecovery(refreshPromise, signal);
  };

  return {
    getToken: (signal?: AbortSignal) => {
      const tokenPromise = refreshPromise ?? readCachedToken(clerk);
      return waitForAuthRecovery(tokenPromise, signal);
    },
    refreshAuth,
  };
}

function setupForegroundRequestListeners(
  catchUpTarget: EventTarget,
  blockUntilForeground: () => void,
  signal: AbortSignal,
): void {
  const handleVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      blockUntilForeground();
      return;
    }
    publishForegroundRequest("visibilitychange");
    catchUpTarget.dispatchEvent(new Event(FOREGROUND_CATCH_UP_REQUEST_EVENT));
  };
  const requestCatchUp = (trigger: "focus" | "online"): void => {
    if (document.visibilityState === "visible") {
      publishForegroundRequest(trigger);
      catchUpTarget.dispatchEvent(new Event(FOREGROUND_CATCH_UP_REQUEST_EVENT));
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange, {
    signal,
  });
  window.addEventListener(
    "focus",
    () => {
      requestCatchUp("focus");
    },
    { signal },
  );
  window.addEventListener(
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
export const setupAuthCatchUp$ = command(
  ({ get, set }, authRecovery: AuthRecovery, signal: AbortSignal): void => {
    const catchUpTarget = get(foregroundCatchUpTarget$);
    let catchUpPromise: Promise<void> | null = null;
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
          details: { visibilityState: document.visibilityState },
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
      if (document.visibilityState !== "visible") {
        blockUntilForeground();
        return;
      }
      if (hiddenReady && !hiddenReady.settled()) {
        hiddenReady.resolve();
      }
      if (hiddenReadySpanId !== null && hiddenReadyStartedAtMs !== null) {
        publishConnectionDiagnostic({
          details: { visibilityState: document.visibilityState },
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

    if (document.visibilityState === "visible") {
      markForegroundReady();
    } else {
      blockUntilForeground();
    }

    const catchUpAfterAuth = (): Promise<void> => {
      if (!catchUpPromise) {
        const spanId = createConnectionDiagnosticSpanId();
        const startedAtMs = now();
        publishConnectionDiagnostic({
          event: "foreground.catch-up",
          phase: "start",
          spanId,
        });
        const catchUp = withCleanup(
          set(
            runTrackedForegroundCatchUp$,
            {
              authRecovery,
              spanId,
              startedAtMs,
              subscriberCount: get(foregroundCatchUpCommands$).size,
            },
            signal,
          ),
          () => {
            if (catchUpPromise === catchUp) {
              catchUpPromise = null;
              catchUpSpanId = null;
            }
            markForegroundReady();
          },
        );
        catchUpPromise = catchUp;
        catchUpSpanId = spanId;
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
        await catchUpAfterAuth();
      }),
      { signal },
    );

    setupForegroundRequestListeners(
      catchUpTarget,
      blockUntilForeground,
      signal,
    );
  },
);

type SettledClerkSession = Exclude<Clerk["session"], undefined>;
type AuthClerkWaitName = Extract<
  ConnectionDiagnosticEventName,
  `auth.clerk.${string}`
>;

async function runAuthDiagnosticWait<T>(
  name: AuthClerkWaitName,
  attempt: number,
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const spanId = createConnectionDiagnosticSpanId();
  const startedAtMs = now();
  publishConnectionDiagnostic({
    details: { attempt },
    event: name,
    phase: "start",
    spanId,
  });
  const result = await settle(operation(), signal);
  if (!result.ok) {
    publishConnectionDiagnostic({
      details: { ...connectionDiagnosticError(result.error), attempt },
      durationMs: now() - startedAtMs,
      event: name,
      phase: "error",
      spanId,
    });
    throw result.error;
  }
  publishConnectionDiagnostic({
    details: { attempt },
    durationMs: now() - startedAtMs,
    event: name,
    phase: "finish",
    spanId,
  });
  return result.value;
}

async function runTrackedAuthRefresh(
  clerk: ClerkLike,
  signal: AbortSignal,
  spanId: string,
  startedAtMs: number,
): Promise<string | null> {
  const result = await settle(runAuthRefresh(clerk, signal), signal);
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

function runAuthRefresh(
  clerk: ClerkLike,
  signal: AbortSignal,
): Promise<string | null> {
  let attempt = 0;
  return retryAuthRecoveryOperation(() => {
    attempt += 1;
    return refreshClerkSession(clerk, attempt, signal);
  }, signal);
}

async function refreshClerkSession(
  clerk: ClerkLike,
  attempt: number,
  signal: AbortSignal,
): Promise<string | null> {
  const session = await runAuthDiagnosticWait(
    "auth.clerk.session-before-touch",
    attempt,
    () => {
      return waitForSettledClerkSession(clerk, signal);
    },
    signal,
  );
  if (session === null) {
    return null;
  }

  await runAuthDiagnosticWait(
    "auth.clerk.touch",
    attempt,
    async () => {
      await session.touch({ intent: "focus" });
    },
    signal,
  );

  // Clerk may replace or clear the session while touch is in flight.
  const refreshedSession = await runAuthDiagnosticWait(
    "auth.clerk.session-after-touch",
    attempt,
    () => {
      return waitForSettledClerkSession(clerk, signal);
    },
    signal,
  );
  if (refreshedSession === null) {
    return null;
  }

  return await runAuthDiagnosticWait(
    "auth.clerk.token",
    attempt,
    () => {
      return refreshedSession.getToken({ skipCache: true });
    },
    signal,
  );
}

async function readCachedToken(clerk: ClerkLike): Promise<string | null> {
  return (await clerk.session?.getToken()) ?? null;
}

function waitForAuthRecovery<T>(
  recovery: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return recovery;
  }
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  return withCleanup(Promise.race([recovery, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(new DOMException("Auth recovery settled", "AbortError"));
    }
  });
}

function isClerkOfflineError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "clerk_offline"
  );
}

function isClerkNetworkError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("ClerkJS: Network error")
  );
}

function isAuthRecoveryNetworkError(error: unknown): boolean {
  return (
    isClerkOfflineError(error) ||
    isClerkNetworkError(error) ||
    isNetworkRequestError(error)
  );
}

function retryAuthRecoveryOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return retryWithFibonacciBackoff(
    operation,
    isAuthRecoveryNetworkError,
    signal,
  );
}
