import { command, computed, state } from "ccstate";
import {
  zeroConnectorScopeDiffContract,
  type ConnectorType,
  type ScopeDiff,
} from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";
import { logger } from "../../log.ts";
import { detach, onRef, Reason, throwIfAbort } from "../../utils.ts";

const L = logger("ScopeReviewModal");

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalScopeDiff$ = state<ScopeDiff | null>(null);
const internalLoading$ = state(false);
const internalConnectorType$ = state<ConnectorType | null>(null);

// ---------------------------------------------------------------------------
// Exported read-only atoms
// ---------------------------------------------------------------------------

export const scopeDiff$ = computed((get) => get(internalScopeDiff$));
export const scopeReviewLoading$ = computed((get) => get(internalLoading$));
export const scopeReviewConnectorType$ = computed((get) =>
  get(internalConnectorType$),
);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Set the connector type for scope review. Must be called before the
 * dialog mounts so the onRef command knows which type to load.
 * Resets state for a fresh modal session.
 */
export const setScopeReviewConnectorType$ = command(
  ({ set }, type: ConnectorType | null) => {
    set(internalScopeDiff$, null);
    set(internalLoading$, false);
    set(internalConnectorType$, type);
  },
);

/**
 * Load scope diff for the current connector type.
 * Triggered via onRef when the dialog content mounts.
 * Uses the AbortSignal from onRef to skip state updates after unmount.
 */
const loadScopeDiff$ = command(
  ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
    const connectorType = get(internalConnectorType$);
    if (!connectorType) {
      set(internalScopeDiff$, null);
      return;
    }
    set(internalLoading$, true);
    const createClient = get(zeroClient$);
    const client = createClient(zeroConnectorScopeDiffContract);
    detach(
      client
        .getScopeDiff({ params: { type: connectorType } })
        .then((result) => {
          signal.throwIfAborted();
          if (result.status === 200) {
            set(internalScopeDiff$, result.body);
          } else {
            L.error(
              `Failed to fetch scope diff: ${result.status}`,
              result.body,
            );
          }
          set(internalLoading$, false);
        })
        .catch((error: unknown) => {
          throwIfAbort(error);
          L.error("Failed to fetch scope diff:", error);
          set(internalLoading$, false);
        }),
      Reason.DomCallback,
    );
  },
);

/** Ref callback that triggers scope diff loading on dialog mount. */
export const scopeReviewRef$ = onRef(loadScopeDiff$);
