import { useGet, useLastResolved, useSet } from "ccstate-react";
import { IconLock } from "@tabler/icons-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";

import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  setWorkflowWebhookUpgradeDialogOpen$,
  workflowWebhookUpgradeDialogOpen$,
} from "../../signals/workflows-page/workflows-signals.ts";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../signals/zero-page/settings/settings-dialog.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function WorkflowWebhookUpgradeDialog() {
  const open = useGet(workflowWebhookUpgradeDialogOpen$);
  const setOpen = useSet(setWorkflowWebhookUpgradeDialogOpen$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const setSettingsDialogOpen = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);

  const upgrade = () => {
    setOpen(false);
    openBillingPlans();
    detach(
      setSettingsDialogOpen(true, pageSignal),
      Reason.DomCallback,
      "open Team billing plans for webhook automations",
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
            <IconLock size={19} stroke={1.6} />
          </div>
          <DialogTitle>Upgrade for webhook automations</DialogTitle>
          <DialogDescription>
            Webhook automations require a Team or Custom workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              Team
            </span>
            <span className="text-sm font-medium text-foreground">
              Secure inbound workflow automation
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            Create signed endpoints that start workflows from external systems.
          </p>
        </div>
        {!isAdmin ? (
          <p className="text-sm text-muted-foreground">
            Ask a workspace admin to upgrade.
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
          >
            {isAdmin ? "Cancel" : "Close"}
          </Button>
          {isAdmin ? (
            <Button type="button" onClick={upgrade}>
              Upgrade to Team
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
