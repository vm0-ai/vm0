import { useGet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";

import { forceUpgradeDialogOpen$ } from "../../signals/force-upgrade.ts";

type ForceUpgradeDialogProps = {
  readonly reload?: () => void;
};

function reloadPage(): void {
  window.location.reload();
}

export function ForceUpgradeDialog({
  reload = reloadPage,
}: ForceUpgradeDialogProps) {
  const open = useGet(forceUpgradeDialogOpen$);

  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-md [&_[aria-label='Close']]:hidden"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Update required</DialogTitle>
          <DialogDescription>
            This version of vm0 is no longer supported. Refresh to load the
            latest version.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={reload}>
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
