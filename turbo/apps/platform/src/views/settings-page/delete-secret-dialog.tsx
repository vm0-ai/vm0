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
  secretDeleteDialogState$,
  secretActionPromise$,
  closeDeleteSecretDialog$,
  confirmDeleteSecret$,
} from "../../signals/settings-page/secrets.ts";

export function DeleteSecretDialog() {
  const deleteState = useGet(secretDeleteDialogState$);
  const actionStatus = useLoadable(secretActionPromise$);
  const closeDelete = useSet(closeDeleteSecretDialog$);
  const confirmDel = useSet(confirmDeleteSecret$);
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
            Are you sure you want to delete this secret?
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-secondary-foreground">
          This will permanently delete the secret{" "}
          <span className="font-mono font-medium">
            {deleteState.secretName}
          </span>
          . Any agents that reference this secret will fail until you add it
          back.
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
