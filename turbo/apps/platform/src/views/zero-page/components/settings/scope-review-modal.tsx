import { useGet, useSet } from "ccstate-react";
import { useCCState, useCommand } from "ccstate-react/experimental";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { CONNECTOR_TYPES, type ConnectorType, type ScopeDiff } from "@vm0/core";
import { ConnectorIcon } from "./connector-icons.tsx";
import { fetch$ } from "../../../../signals/fetch.ts";

interface ScopeReviewModalProps {
  connectorType: ConnectorType | null;
  onClose: () => void;
  onReconnect: (type: ConnectorType) => void;
}

export function ScopeReviewModal({
  connectorType,
  onClose,
  onReconnect,
}: ScopeReviewModalProps) {
  const fetchFn = useGet(fetch$);
  const scopeDiff$ = useCCState<ScopeDiff | null>(null);
  const loading$ = useCCState(false);
  const scopeDiff = useGet(scopeDiff$);
  const loading = useGet(loading$);
  const setLoading = useSet(loading$);
  const setScopeDiff = useSet(scopeDiff$);

  const loadScopeDiff = useSet(
    useCommand(({ set }) => {
      if (!connectorType) {
        set(scopeDiff$, null);
        return;
      }
      set(loading$, true);
      fetchFn(`/api/connectors/${connectorType}/scope-diff`)
        .then((resp) => resp.json())
        .then((data: ScopeDiff) => {
          setScopeDiff(data);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        });
    }),
  );

  // Load on first render when connectorType is set
  if (connectorType && !scopeDiff && !loading) {
    loadScopeDiff();
  }

  if (!connectorType) {
    return null;
  }

  const config = CONNECTOR_TYPES[connectorType];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={connectorType} size={28} />
            <DialogTitle>{config.label} — Permissions Update</DialogTitle>
          </div>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">
            Loading scope changes...
          </p>
        ) : scopeDiff ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              The required permissions for this connector have changed. Please
              review and reconnect to apply the update.
            </p>

            {scopeDiff.addedScopes.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  New permissions
                </span>
                <ul className="flex flex-col gap-1">
                  {scopeDiff.addedScopes.map((scope) => (
                    <li
                      key={scope}
                      className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400"
                    >
                      <span>+</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {scope}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {scopeDiff.removedScopes.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Removed permissions
                </span>
                <ul className="flex flex-col gap-1">
                  {scopeDiff.removedScopes.map((scope) => (
                    <li
                      key={scope}
                      className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"
                    >
                      <span>-</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {scope}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => onReconnect(connectorType)}
                className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Reconnect
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Failed to load scope changes.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
