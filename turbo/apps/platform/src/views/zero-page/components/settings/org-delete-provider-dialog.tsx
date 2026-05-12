import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  orgDeleteDialogState$,
  orgActionPromise$,
  orgCloseDeleteDialog$,
  orgConfirmDelete$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";

export function OrgDeleteProviderDialog() {
  const deleteState = useGet(orgDeleteDialogState$);
  const actionStatus = useLoadable(orgActionPromise$);
  const closeDelete = useSet(orgCloseDeleteDialog$);
  const confirmDel = useSet(orgConfirmDelete$);
  const pageSignal = useGet(pageSignal$);

  const isLoading = actionStatus.state === "loading";

  const handleDelete = () => {
    detach(confirmDel(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={deleteState.open}
      onOpenChange={() => {
        return closeDelete();
      }}
    >
      <DialogContent className="max-w-2xl gap-6">
        <DialogHeader>
          <DialogTitle className="font-normal leading-7">
            Are you sure you want to delete this workspace model provider?
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>
          This will remove the workspace provider and its settings, including
          keys and tokens. Model routes that use this provider will need to be
          updated before they can run again. You can always add it back later
          and set it up again.
        </DialogDescription>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              return closeDelete();
            }}
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
