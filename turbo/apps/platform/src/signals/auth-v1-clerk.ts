import type { Clerk, ClerkStatus } from "@clerk/shared/types";
import { command, computed, state } from "ccstate";
import { onRef } from "./utils.ts";
import { pageSignal$ } from "./page-signal.ts";

/** A route-owned subscription to the external Clerk runtime. */
export function createAuthV1ClerkSignals() {
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
            set(observe$, clerk, AbortSignal.any([signal, get(pageSignal$)]));
          },
        ),
      );
      return set(ref$, element);
    },
  );
  return { ready$, attach$ };
}

export type AuthV1ClerkSignals = ReturnType<typeof createAuthV1ClerkSignals>;
