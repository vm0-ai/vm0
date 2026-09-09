import type { ClerkProviderProps } from "@clerk/react";
import type { Clerk, ClerkStatus } from "@clerk/shared/types";
import { command, computed, state } from "ccstate";
import { registerClerkRouter } from "../lib/clerk-runtime.ts";
import { onRef } from "./utils.ts";
import { pageSignal$ } from "./page-signal.ts";
import { detachedNavigateTo$ } from "./route.ts";
import type { RoutePath } from "./route-paths.ts";

type ClerkRouter = NonNullable<ClerkProviderProps["routerPush"]>;
type ClerkRouterMetadata = Parameters<ClerkRouter>[1];

/** A route-owned integration with the external Clerk runtime. */
export function createAuthV1ClerkSignals() {
  const navigateClerkUrl$ = command(
    (
      { set },
      url: string,
      metadata: ClerkRouterMetadata,
      replace: boolean,
    ): void => {
      const destination = new URL(url, window.location.href);
      if (destination.origin !== window.location.origin) {
        // Clerk keeps ownership of protocol checks and cross-origin loads.
        metadata?.windowNavigate(url);
        return;
      }
      // The route table has a final catch-all, so every same-origin pathname
      // is a valid runtime destination even when it is not a generated route.
      set(detachedNavigateTo$, destination.pathname as RoutePath, {
        hash: destination.hash,
        replace,
        searchParams: destination.searchParams,
      });
    },
  );
  const clerkRouterPush$ = command(
    ({ set }, url: string, metadata?: ClerkRouterMetadata): void => {
      set(navigateClerkUrl$, url, metadata, false);
    },
  );
  const clerkRouterReplace$ = command(
    ({ set }, url: string, metadata?: ClerkRouterMetadata): void => {
      set(navigateClerkUrl$, url, metadata, true);
    },
  );
  const status$ = state<ClerkStatus>("loading");
  const ready$ = computed((get) => {
    const status = get(status$);
    return status === "ready" || status === "degraded";
  });
  const receiveStatus$ = command(({ set }, status: ClerkStatus) => {
    set(status$, status);
  });
  const observe$ = command(
    ({ set }, clerk: Pick<Clerk, "on" | "off">, signal: AbortSignal): void => {
      if (signal.aborted) {
        return;
      }
      const receiveStatus = (status: ClerkStatus) => {
        if (!signal.aborted) {
          set(receiveStatus$, status);
        }
      };
      // Request the current value too: the provider may mount after bootstrap.
      clerk.on("status", receiveStatus, { notify: true });
      signal.addEventListener(
        "abort",
        () => {
          clerk.off("status", receiveStatus);
        },
        { once: true },
      );
    },
  );
  // The provider handle arrives at its committed marker. Own the subscription
  // through onRef so replacement and unmount release the exact SDK listener.
  const attach$ = command(
    ({ set }, element: HTMLSpanElement, clerk: Pick<Clerk, "on" | "off">) => {
      const ref$ = onRef(
        command(
          ({ get, set }, _element: HTMLSpanElement, signal: AbortSignal) => {
            const routeSignal = AbortSignal.any([signal, get(pageSignal$)]);
            if (routeSignal.aborted) {
              return;
            }
            const unregisterRouter = registerClerkRouter({
              push(url, metadata) {
                set(clerkRouterPush$, url, metadata);
              },
              replace(url, metadata) {
                set(clerkRouterReplace$, url, metadata);
              },
            });
            routeSignal.addEventListener("abort", unregisterRouter, {
              once: true,
            });
            set(observe$, clerk, routeSignal);
          },
        ),
      );
      return set(ref$, element);
    },
  );
  return { ready$, attach$, clerkRouterPush$, clerkRouterReplace$ };
}

export type AuthV1ClerkSignals = ReturnType<typeof createAuthV1ClerkSignals>;
