import {
  ZERO_BROWSER_IDLE_LEASE_MINUTES,
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { browserSessionChangedPayloadSchema } from "@vm0/api-contracts/contracts/realtime";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { animationFrame } from "signal-timers";

import { formatAppNumber } from "../../i18n/format.ts";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { zeroBrowserEnabled$ } from "../external/feature-switch.ts";
import { pageSignal$ } from "../page-signal.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import {
  createDeferredPromise,
  onRef,
  settle,
  setLoop,
  withCleanup,
} from "../utils.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

// One heartbeat per minute keeps a viewed browser comfortably inside its
// ten-minute idle lease without making the lease itself stackable.
const LEASE_HEARTBEAT_INTERVAL_MS = 60_000;

export interface BrowserSessionDescriptor {
  readonly threadId: string;
  readonly href: string;
}

export interface BrowserSessionSignals extends BrowserSessionDescriptor {
  readonly session$: Computed<Promise<ZeroBrowserSession | null>>;
  readonly panelSession$: Computed<Promise<ZeroBrowserSession | null>>;
  readonly starting$: Computed<boolean>;
  readonly stopping$: Computed<boolean>;
  readonly fittingWindow$: Computed<boolean>;
  readonly reload$: Command<void, []>;
  readonly reloadPanel$: Command<void, []>;
  readonly start$: Command<Promise<void>, [AbortSignal]>;
  readonly stop$: Command<Promise<void>, [AbortSignal]>;
  readonly fitViewport$: Command<Promise<void>, [HTMLElement, AbortSignal]>;
  readonly autoFitViewportRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly subscribe$: Command<Promise<void>, [AbortSignal]>;
  // Attach to the visible panel container: the lease heartbeat lives exactly as
  // long as that element is mounted.
  readonly keepAliveRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

export interface BrowserLifecycleOptimisticEvents {
  readonly append$: Command<
    Promise<void>,
    [
      {
        readonly eventId: string;
        readonly eventType: "browser.started" | "browser.stopped";
      },
      AbortSignal,
    ]
  >;
}

export function parseBrowserSessionUrl(
  value: string,
): BrowserSessionDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (!url) {
    return null;
  }
  const match = url.pathname.match(
    /^\/browsers\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/iu,
  );
  const threadId = match?.[1];
  if (!threadId) {
    return null;
  }
  return {
    threadId,
    href: `/browsers/${threadId}`,
  };
}

function viewerIsVisible(): boolean {
  return typeof document === "undefined"
    ? false
    : document.visibilityState === "visible";
}

async function fetchBrowserSession(
  createClient: ZeroClientFactory,
  threadId: string,
  signal: AbortSignal,
): Promise<ZeroBrowserSession | null> {
  const response = await accept(
    createClient(zeroBrowserContract).get({
      params: { threadId },
      fetchOptions: { signal },
    }),
    [200, 404],
  );
  return response.status === 200 ? response.body.browser : null;
}

function isActiveSidebarSizeTransition(animation: Animation): boolean {
  if (!("transitionProperty" in animation)) {
    return false;
  }
  const property = animation.transitionProperty;
  return (
    (property === "flex-basis" || property === "width") &&
    animation.playState !== "finished" &&
    animation.playState !== "idle"
  );
}

function waitForBrowserSidebarLayout(
  viewport: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const sidebarPane = viewport.closest<HTMLElement>(
    "[data-chat-thread-sidebar-pane]",
  );
  if (!sidebarPane) {
    throw new Error("Browser viewport is outside the thread sidebar pane");
  }
  const pane = sidebarPane;

  const ready = createDeferredPromise<void>(signal);
  function cleanup(): void {
    pane.removeEventListener("transitionend", handleTransitionSettled);
    pane.removeEventListener("transitioncancel", handleTransitionSettled);
    signal.removeEventListener("abort", cleanup);
  }
  function finish(): void {
    cleanup();
    if (!ready.settled()) {
      ready.resolve(undefined);
    }
  }
  function handleTransitionSettled(event: TransitionEvent): void {
    if (
      event.target === pane &&
      (event.propertyName === "flex-basis" || event.propertyName === "width")
    ) {
      finish();
    }
  }

  pane.addEventListener("transitionend", handleTransitionSettled);
  pane.addEventListener("transitioncancel", handleTransitionSettled);
  signal.addEventListener("abort", cleanup, { once: true });
  animationFrame(
    () => {
      const animations =
        typeof pane.getAnimations === "function" ? pane.getAnimations() : [];
      if (!animations.some(isActiveSidebarSizeTransition)) {
        finish();
      }
    },
    { signal },
  );
  return ready.promise;
}

function createFitWindowSignals(
  descriptor: BrowserSessionDescriptor,
  session$: BrowserSessionSignals["session$"],
  sessionOverride$: State<ZeroBrowserSession | null | undefined>,
): Pick<
  BrowserSessionSignals,
  "autoFitViewportRef$" | "fittingWindow$" | "fitViewport$"
> {
  const fittingWindowState$ = state(false);
  const fitWindow$ = command(
    async (
      { get, set },
      aspectRatio: number,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!get(zeroBrowserEnabled$) || get(fittingWindowState$)) {
        return;
      }
      set(fittingWindowState$, true);
      const fitted = await settle(
        withCleanup(
          accept(
            get(zeroClient$)(zeroBrowserContract).resizeByThread({
              params: { threadId: descriptor.threadId },
              body: { aspectRatio },
              fetchOptions: { signal },
            }),
            [200],
            signal,
          ),
          () => {
            set(fittingWindowState$, false);
          },
        ),
        signal,
      );
      if (fitted.ok) {
        set(sessionOverride$, fitted.value.body.browser);
      }
    },
  );
  const fitViewport$ = command(
    async (
      { get, set },
      viewport: HTMLElement,
      signal: AbortSignal,
    ): Promise<void> => {
      const session = await get(session$);
      signal.throwIfAborted();
      if (
        session?.status !== "active" ||
        session.liveUrl === null ||
        session.screen?.resizable !== true
      ) {
        return;
      }
      const { width, height } = viewport.getBoundingClientRect();
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      ) {
        return;
      }
      await set(fitWindow$, width / height, signal);
    },
  );
  const autoFitViewportRef$ = onRef(
    command(
      async (
        { set },
        viewport: HTMLElement,
        signal: AbortSignal,
      ): Promise<void> => {
        await waitForBrowserSidebarLayout(viewport, signal);
        await set(fitViewport$, viewport, signal);
      },
    ),
  );
  return {
    autoFitViewportRef$,
    fittingWindow$: computed((get) => {
      return get(fittingWindowState$);
    }),
    fitViewport$,
  };
}

interface BrowserMutationSignalContext {
  readonly descriptor: BrowserSessionDescriptor;
  readonly session$: Computed<Promise<ZeroBrowserSession | null>>;
  readonly sessionOverride$: State<ZeroBrowserSession | null | undefined>;
  readonly reload$: Command<void, []>;
  readonly optimisticEvents?: BrowserLifecycleOptimisticEvents;
}

function createStartBrowserSignals({
  descriptor,
  sessionOverride$,
  reload$,
  optimisticEvents,
}: BrowserMutationSignalContext): Pick<
  BrowserSessionSignals,
  "starting$" | "start$"
> {
  const startingState$ = state(false);
  const start$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(zeroBrowserEnabled$)) {
      return;
    }
    const eventId = crypto.randomUUID();
    set(startingState$, true);
    if (optimisticEvents) {
      await set(
        optimisticEvents.append$,
        {
          eventId,
          eventType: "browser.started",
        },
        signal,
      );
      signal.throwIfAborted();
    }
    const started = await settle(
      accept(
        get(zeroClient$)(zeroBrowserContract).start({
          params: { threadId: descriptor.threadId },
          body: { eventId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      ),
      signal,
    );
    set(startingState$, false);
    if (started.ok) {
      set(sessionOverride$, started.value.body.browser);
      return;
    }
    set(reload$);
  });
  return {
    starting$: computed((get) => {
      return get(startingState$);
    }),
    start$,
  };
}

function createStopBrowserSignals({
  descriptor,
  session$,
  sessionOverride$,
  reload$,
  optimisticEvents,
}: BrowserMutationSignalContext): Pick<
  BrowserSessionSignals,
  "stopping$" | "stop$"
> {
  const stoppingState$ = state(false);
  const stop$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(zeroBrowserEnabled$)) {
      return;
    }
    const eventId = crypto.randomUUID();
    const current = await settle(get(session$), signal);
    signal.throwIfAborted();
    set(stoppingState$, true);
    if (optimisticEvents) {
      await set(
        optimisticEvents.append$,
        {
          eventId,
          eventType: "browser.stopped",
        },
        signal,
      );
      signal.throwIfAborted();
    }
    if (current.ok && current.value) {
      const stoppedAt = nowDate().toISOString();
      set(sessionOverride$, {
        ...current.value,
        status: "suspended",
        liveUrl: null,
        idleExpiresAt: null,
        suspendedAt: stoppedAt,
        suspensionReason: "user",
        updatedAt: stoppedAt,
      });
    }
    const stopped = await settle(
      accept(
        get(zeroClient$)(zeroBrowserContract).stop({
          params: { threadId: descriptor.threadId },
          body: { eventId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      ),
      signal,
    );
    set(stoppingState$, false);
    if (stopped.ok) {
      set(sessionOverride$, stopped.value.body.browser);
      return;
    }
    set(reload$);
  });
  return {
    stopping$: computed((get) => {
      return get(stoppingState$);
    }),
    stop$,
  };
}

function createBrowserSessionSubscriptionSignals(
  descriptor: BrowserSessionDescriptor,
  reload$: BrowserSessionSignals["reload$"],
): Pick<BrowserSessionSignals, "subscribe$"> {
  const reloadBrowserSession$ = command(
    ({ set }, _signal: AbortSignal): boolean => {
      set(reload$);
      return false;
    },
  );
  const onBrowserSessionChanged$ = command(
    ({ set }, payload: unknown, _signal: AbortSignal): boolean => {
      const parsed = browserSessionChangedPayloadSchema.safeParse(payload);
      if (parsed.success && parsed.data.threadId === descriptor.threadId) {
        set(reload$);
      }
      return false;
    },
  );
  const subscribe$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await set(
        setAblyPayloadLoop$,
        {
          topic: "browserSessionChanged",
          loopCommand$: onBrowserSessionChanged$,
          catchUpCommand$: reloadBrowserSession$,
          options: { runOnSubscribe: true },
        },
        signal,
      );
    },
  );
  return { subscribe$ };
}

export function createBrowserSessionSignals(
  threadId: string,
  optimisticEvents?: BrowserLifecycleOptimisticEvents,
): BrowserSessionSignals {
  const descriptor: BrowserSessionDescriptor = {
    threadId,
    href: `/browsers/${threadId}`,
  };
  const reloadVersion$ = state(0);
  const sessionOverride$ = state<ZeroBrowserSession | null | undefined>(
    undefined,
  );
  const session$ = computed(async (get): Promise<ZeroBrowserSession | null> => {
    get(reloadVersion$);
    if (!get(zeroBrowserEnabled$)) {
      return null;
    }
    const override = get(sessionOverride$);
    return override === undefined
      ? await fetchBrowserSession(
          get(zeroClient$),
          descriptor.threadId,
          get(pageSignal$),
        )
      : override;
  });
  const reload$ = command(({ set }) => {
    set(sessionOverride$, undefined);
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });

  const { autoFitViewportRef$, fittingWindow$, fitViewport$ } =
    createFitWindowSignals(descriptor, session$, sessionOverride$);
  const mutationContext: BrowserMutationSignalContext = {
    descriptor,
    session$,
    sessionOverride$,
    reload$,
    ...(optimisticEvents ? { optimisticEvents } : {}),
  };
  const startSignals = createStartBrowserSignals(mutationContext);
  const stopSignals = createStopBrowserSignals(mutationContext);
  const subscriptionSignals = createBrowserSessionSubscriptionSignals(
    descriptor,
    reload$,
  );

  const keepAliveRef$ = onRef(
    command(
      async ({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
        await setLoop(
          async () => {
            if (!get(zeroBrowserEnabled$)) {
              return true;
            }
            if (!viewerIsVisible()) {
              return false;
            }
            const response = await accept(
              get(zeroClient$)(zeroBrowserContract).leaseByThread({
                params: { threadId: descriptor.threadId },
                body: {},
                fetchOptions: { signal },
              }),
              [200, 404, 409],
            );
            if (response.status === 200) {
              const currentSession = await get(session$);
              signal.throwIfAborted();
              set(
                sessionOverride$,
                currentSession
                  ? {
                      ...response.body.browser,
                      // Lease responses intentionally omit the provider live
                      // URL, so retain the one loaded by the viewer endpoint.
                      liveUrl: currentSession.liveUrl,
                    }
                  : response.body.browser,
              );
              return false;
            }
            // The browser was reclaimed while the panel was hidden or idle. Stop
            // the heartbeat and let the panel offer a resume instead.
            set(reload$);
            return true;
          },
          LEASE_HEARTBEAT_INTERVAL_MS,
          signal,
        );
      },
    ),
  );

  return {
    ...descriptor,
    session$,
    panelSession$: session$,
    ...startSignals,
    ...stopSignals,
    autoFitViewportRef$,
    fittingWindow$,
    reload$,
    reloadPanel$: reload$,
    fitViewport$,
    ...subscriptionSignals,
    keepAliveRef$,
  };
}

export function browserSessionReclaimHint(
  session: ZeroBrowserSession,
): string | null {
  return session.status === "active"
    ? i18n.t(
        ($) => {
          return $.browserSession.reclaimHint;
        },
        {
          count: ZERO_BROWSER_IDLE_LEASE_MINUTES,
          formattedCount: formatAppNumber(ZERO_BROWSER_IDLE_LEASE_MINUTES),
        },
      )
    : null;
}
