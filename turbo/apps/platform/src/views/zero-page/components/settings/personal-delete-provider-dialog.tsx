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
  personalDeleteDialogState$,
  personalActionPromise$,
  personalCloseDeleteDialog$,
  personalConfirmDelete$,
} from "../../../../signals/zero-page/settings/personal-model-providers.ts";

export function PersonalDeleteProviderDialog() {
  const deleteState = useGet(personalDeleteDialogState$);
  const actionStatus = useLoadable(personalActionPromise$);
  const closeDelete = useSet(personalCloseDeleteDialog$);
  const confirmDel = useSet(personalConfirmDelete$);
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
            Delete this personal model provider?
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>
          This removes the provider and its keys from your account only. Org
          providers and other members are not affected. You can add it back
          later and set it up again.
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
