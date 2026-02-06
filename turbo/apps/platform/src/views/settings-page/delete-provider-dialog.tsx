import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { MODEL_PROVIDER_TYPES } from "@vm0/core";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  deleteDialogState$,
  actionPromise$,
  closeDeleteDialog$,
  confirmDelete$,
} from "../../signals/settings-page/model-providers.ts";

export function DeleteProviderDialog() {
  const deleteState = useGet(deleteDialogState$);
  const actionStatus = useLoadable(actionPromise$);
  const closeDelete = useSet(closeDeleteDialog$);
  const confirmDel = useSet(confirmDelete$);
  const pageSignal = useGet(pageSignal$);

  const isLoading = actionStatus.state === "loading";
  const providerLabel = deleteState.providerType
    ? MODEL_PROVIDER_TYPES[deleteState.providerType].label
    : "";

  const handleDelete = () => {
    detach(confirmDel(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog open={deleteState.open} onOpenChange={() => closeDelete()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {providerLabel}</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this model provider? This will
            remove all stored credentials and configuration. Sandboxes using
            this provider will need to be reconfigured.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => closeDelete()}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isLoading}
          >
            {isLoading ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
