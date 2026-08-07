import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
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
import { brandName$ } from "../../signals/branding.ts";

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
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

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
          <DialogTitle>
            {t(($) => {
              return $.shared.forceUpgrade.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.shared.forceUpgrade.description;
              },
              { brandName },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={reload}>
            {t(($) => {
              return $.shared.forceUpgrade.action;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
