import {
  ZERO_BROWSER_IDLE_LEASE_MINUTES,
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { browserSessionChangedPayloadSchema } from "@vm0/api-contracts/contracts/realtime";
import { command, computed, state, type Command, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { onRef, settle, setLoop } from "../utils.ts";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

// One heartbeat per minute keeps a viewed browser comfortably inside its
// ten-minute idle lease without making the lease itself stackable.
const LEASE_HEARTBEAT_INTERVAL_MS = 60_000;

export interface BrowserSessionDescriptor {
  readonly browserId: string;
  readonly originalUrl: string;
  readonly href: string;
  readonly fallbackMarkdown: string;
}

export interface BrowserSessionSignals extends BrowserSessionDescriptor {
  readonly threadId: string | null;
  readonly session$: Computed<Promise<ZeroBrowserSession | null>>;
  readonly panelSession$: Computed<Promise<ZeroBrowserSession | null>>;
  readonly resuming$: Computed<boolean>;
  readonly reload$: Command<void, []>;
  readonly reloadPanel$: Command<void, []>;
  readonly resume$: Command<Promise<void>, [AbortSignal]>;
  // Attach to the visible panel container: the lease heartbeat lives exactly as
  // long as that element is mounted.
  readonly keepAliveRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

export interface BrowserSessionCardSignalsRegistry {
  register(descriptor: BrowserSessionDescriptor): BrowserSessionSignals;
  resolve(resourceKey: string): BrowserSessionSignals;
  entries(): ReadonlyMap<string, BrowserSessionSignals>;
  readonly subscribe$: Command<Promise<void>, [AbortSignal]>;
}

export function parseBrowserSessionUrl(
  value: string,
  fallbackMarkdown: string = value,
): BrowserSessionDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (!url) {
    return null;
  }
  const match = url.pathname.match(
    /^\/browsers\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/iu,
  );
  const browserId = match?.[1];
  if (!browserId) {
    return null;
  }
  return {
    browserId,
    originalUrl: value,
    href: `/browsers/${browserId}`,
    fallbackMarkdown,
  };
}

function viewerIsVisible(): boolean {
  return typeof document === "undefined"
    ? false
    : document.visibilityState === "visible";
}

async function fetchBrowserSession(
  createClient: ZeroClientFactory,
  args: {
    readonly browserId: string;
    readonly chatThreadId: string | null;
  },
  signal: AbortSignal,
): Promise<ZeroBrowserSession | null> {
  const response = await accept(
    createClient(zeroBrowserContract).get({
      params: { browserId: args.browserId },
      query: args.chatThreadId ? { chatThreadId: args.chatThreadId } : {},
      fetchOptions: { signal },
    }),
    [200, 404],
  );
  return response.status === 200 ? response.body.browser : null;
}

export function createBrowserSessionSignals(
  threadId: string | null,
  descriptor: BrowserSessionDescriptor,
): BrowserSessionSignals {
  const target = { browserId: descriptor.browserId, chatThreadId: threadId };
  const reloadVersion$ = state(0);
  const sessionOverride$ = state<ZeroBrowserSession | null | undefined>(
    undefined,
  );
  const session$ = computed(async (get): Promise<ZeroBrowserSession | null> => {
    get(reloadVersion$);
    const override = get(sessionOverride$);
    return override === undefined
      ? await fetchBrowserSession(get(zeroClient$), target, get(pageSignal$))
      : override;
  });
  const reload$ = command(({ set }) => {
    set(sessionOverride$, undefined);
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });

  const resumingState$ = state(false);
  // accept() reports a failed resume through the app's toast surface, so the
  // panel only has to stop showing a pending state and reload what is real.
  const resume$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(resumingState$, true);
    const resumed = await settle(
      accept(
        get(zeroClient$)(zeroBrowserContract).resumeById({
          params: { browserId: descriptor.browserId },
          body: {},
          fetchOptions: { signal },
        }),
        [200],
        signal,
      ),
      signal,
    );
    set(resumingState$, false);
    if (resumed.ok) {
      set(sessionOverride$, resumed.value.body.browser);
      return;
    }
    set(reload$);
  });

  const keepAliveRef$ = onRef(
    command(
      async ({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
        await setLoop(
          async () => {
            if (!viewerIsVisible()) {
              return false;
            }
            const response = await accept(
              get(zeroClient$)(zeroBrowserContract).leaseById({
                params: { browserId: descriptor.browserId },
                body: {},
                fetchOptions: { signal },
              }),
              [200, 404, 409],
            );
            if (response.status === 200) {
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
    threadId,
    session$,
    panelSession$: session$,
    resuming$: computed((get) => {
      return get(resumingState$);
    }),
    reload$,
    reloadPanel$: reload$,
    resume$,
    keepAliveRef$,
  };
}

export function browserSessionReclaimHint(
  session: ZeroBrowserSession,
): string | null {
  return session.status === "active"
    ? `Zero keeps this browser while this panel is open, and reclaims it after ${ZERO_BROWSER_IDLE_LEASE_MINUTES} idle minutes.`
    : null;
}

export function createBrowserSessionCardSignalsRegistry(
  threadId: string,
): BrowserSessionCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, BrowserSessionSignals>();
  const signalsByBrowserId = new Map<string, BrowserSessionSignals>();
  const reloadAll$ = command(({ set }, _signal: AbortSignal): boolean => {
    for (const signals of signalsByBrowserId.values()) {
      set(signals.reload$);
    }
    return false;
  });
  const onBrowserSessionChanged$ = command(
    ({ set }, payload: unknown, _signal: AbortSignal): boolean => {
      const parsed = browserSessionChangedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return false;
      }
      const signals = signalsByBrowserId.get(parsed.data.browserId);
      if (signals) {
        set(signals.reload$);
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
          catchUpCommand$: reloadAll$,
          options: { runOnSubscribe: true },
        },
        signal,
      );
    },
  );
  return {
    register(descriptor) {
      const shared = getOrCreateCardSignals(
        signalsByBrowserId,
        descriptor.browserId,
        () => {
          return createBrowserSessionSignals(threadId, descriptor);
        },
      );
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.fallbackMarkdown,
        () => {
          return { ...shared, ...descriptor, threadId };
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
    entries() {
      return signalsByBrowserId;
    },
    subscribe$,
  };
}
