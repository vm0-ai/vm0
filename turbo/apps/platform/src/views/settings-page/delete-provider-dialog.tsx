import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
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

  const handleDelete = () => {
    detach(confirmDel(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog open={deleteState.open} onOpenChange={() => closeDelete()}>
      <DialogContent className="max-w-2xl gap-6">
        <DialogHeader>
          <DialogTitle className="font-normal leading-7">
            Are you sure you want to delete this model provider?
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-secondary-foreground">
          This will remove the provider and its settings, including keys and
          tokens. If it&apos;s your default provider, VM0 will switch to another
          one and your agents may be affected. You can always add it back later
          and set it up again.
        </p>
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
