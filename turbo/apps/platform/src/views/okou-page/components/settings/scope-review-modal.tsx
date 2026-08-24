import { useLastResolved, useLoadable } from "ccstate-react";
import { Button } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { useTranslation } from "react-i18next";
import { ConnectorIcon } from "./connector-icons.tsx";
import { scopeDiff$ } from "../../../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../../../signals/external/connectors.ts";

interface ScopeReviewModalProps {
  connectorSlug: ConnectorSlug | null;
  onClose: () => void;
  onReconnect: (connectorSlug: ConnectorSlug) => void;
}

function ScopeDiffContent({
  connectorSlug,
  addedScopes,
  removedScopes,
  onClose,
  onReconnect,
}: {
  connectorSlug: ConnectorSlug;
  addedScopes: readonly string[];
  removedScopes: readonly string[];
  onClose: () => void;
  onReconnect: (connectorSlug: ConnectorSlug) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.permissions.scopeReview.description;
        })}
      </p>

      {addedScopes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t(($) => {
              return $.connectors.permissions.scopeReview.added;
            })}
          </span>
          <ul className="flex flex-col gap-1">
            {addedScopes.map((scope) => {
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

      {removedScopes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t(($) => {
              return $.connectors.permissions.scopeReview.removed;
            })}
          </span>
          <ul className="flex flex-col gap-1">
            {removedScopes.map((scope) => {
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
        <Button
          type="button"
          onClick={() => {
            return onReconnect(connectorSlug);
          }}
          className="flex-1"
        >
          {t(($) => {
            return $.connectors.actions.reconnect;
          })}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          {t(($) => {
            return $.connectors.actions.close;
          })}
        </Button>
      </div>
    </div>
  );
}

export function ScopeReviewModal({
  connectorSlug,
  onClose,
  onReconnect,
}: ScopeReviewModalProps) {
  const { t } = useTranslation();
  const scopeDiffLoadable = useLoadable(scopeDiff$);
  const connectorCatalog = useLastResolved(connectorCatalogStatus$);
  const loading = scopeDiffLoadable.state === "loading";
  const scopeDiff =
    scopeDiffLoadable.state === "hasData" ? scopeDiffLoadable.data : null;

  if (!connectorSlug) {
    return null;
  }

  const connector = connectorCatalog?.connectors.find((candidate) => {
    return candidate.slug === connectorSlug;
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
            <DialogTitle>
              {t(
                ($) => {
                  return $.connectors.permissions.scopeReview.title;
                },
                { connector: connectorLabel },
              )}
            </DialogTitle>
          </div>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.permissions.scopeReview.loading;
            })}
          </p>
        ) : scopeDiff ? (
          <ScopeDiffContent
            connectorSlug={connectorSlug}
            addedScopes={scopeDiff.addedScopes}
            removedScopes={scopeDiff.removedScopes}
            onClose={onClose}
            onReconnect={onReconnect}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.permissions.scopeReview.failed;
            })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
