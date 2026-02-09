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
  variableDeleteDialogState$,
  variableActionPromise$,
  closeDeleteVariableDialog$,
  confirmDeleteVariable$,
} from "../../signals/settings-page/variables.ts";

export function DeleteVariableDialog() {
  const deleteState = useGet(variableDeleteDialogState$);
  const actionStatus = useLoadable(variableActionPromise$);
  const closeDelete = useSet(closeDeleteVariableDialog$);
  const confirmDel = useSet(confirmDeleteVariable$);
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
            Are you sure you want to delete this variable?
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-secondary-foreground">
          This will permanently delete the variable{" "}
          <span className="font-mono font-medium">
            {deleteState.variableName}
          </span>
          . Any agents that reference this variable will fail until you add it
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
