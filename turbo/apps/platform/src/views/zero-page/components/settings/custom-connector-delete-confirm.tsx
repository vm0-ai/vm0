import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";
import {
  closeCustomConnectorDialog$,
  deleteCustomConnector$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";

export function CustomConnectorDeleteConfirm({
  id,
  displayName,
}: {
  id: string;
  displayName: string;
}) {
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [loadable, submit] = useLoadableSet(deleteCustomConnector$);
  const signal = useGet(pageSignal$);
  const submitting = loadable.state === "loading";

  const onConfirm = () => {
    detach(
      (async () => {
        await submit(id, signal);
        closeDialog();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && closeDialog();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Delete {displayName}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This removes the connector and every member&apos;s stored secret for
          it. Agents authorized for this connector will lose access immediately.
          This can&apos;t be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
