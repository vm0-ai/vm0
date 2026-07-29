import { useLastResolved, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import { ConnectorIcon } from "./connector-icons.tsx";
import {
  allConnectorCatalogItems$,
  scopeDiff$,
} from "../../../../signals/zero-page/settings/connectors.ts";

interface ScopeReviewModalProps {
  connectorSlug: ConnectorSlug | null;
  onClose: () => void;
  onReconnect: (connectorSlug: ConnectorSlug) => void;
}

export function ScopeReviewModal({
  connectorSlug,
  onClose,
  onReconnect,
}: ScopeReviewModalProps) {
  const scopeDiffLoadable = useLoadable(scopeDiff$);
  const connectorCatalogItems = useLastResolved(allConnectorCatalogItems$);
  const loading = scopeDiffLoadable.state === "loading";
  const scopeDiff =
    scopeDiffLoadable.state === "hasData" ? scopeDiffLoadable.data : null;

  if (!connectorSlug) {
    return null;
  }

  const connector = connectorCatalogItems?.find((candidate) => {
    return candidate.connectorRef === connectorSlug;
  });
  const connectorLabel = connector?.label ?? connectorSlug;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onClose();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center">
              <ConnectorIcon icon={connector?.icon} size={20} />
            </div>
            <DialogTitle>{connectorLabel} permissions update</DialogTitle>
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
                  {scopeDiff.addedScopes.map((scope) => {
                    return (
                      <li
                        key={scope}
                        className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400"
                      >
                        <span>+</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {scope}
                        </code>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {scopeDiff.removedScopes.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Removed permissions
                </span>
                <ul className="flex flex-col gap-1">
                  {scopeDiff.removedScopes.map((scope) => {
                    return (
                      <li
                        key={scope}
                        className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"
                      >
                        <span>-</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {scope}
                        </code>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  return onReconnect(connectorSlug);
                }}
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
