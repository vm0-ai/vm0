import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  disconnectDialogState$,
  connectorActionPromise$,
  closeDisconnectDialog$,
  confirmDisconnect$,
} from "../../signals/settings-page/connectors.ts";

export function DisconnectConnectorDialog() {
  const dialogState = useGet(disconnectDialogState$);
  const actionStatus = useLoadable(connectorActionPromise$);
  const closeDialog = useSet(closeDisconnectDialog$);
  const confirmDel = useSet(confirmDisconnect$);
  const pageSignal = useGet(pageSignal$);

  const isLoading = actionStatus.state === "loading";
  const connectorLabel = dialogState.connectorType
    ? CONNECTOR_TYPES[dialogState.connectorType as ConnectorType].label
    : "";

  const handleDisconnect = () => {
    detach(confirmDel(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog open={dialogState.open} onOpenChange={() => closeDialog()}>
      <DialogContent className="max-w-2xl gap-6">
        <DialogHeader>
          <DialogTitle className="font-normal leading-7">
            Are you sure you want to disconnect {connectorLabel}?
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-secondary-foreground">
          This will remove the connection and its stored credentials. Your
          agents will no longer have access to {connectorLabel}. You can always
          reconnect later.
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => closeDialog()}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDisconnect}
            disabled={isLoading}
          >
            {isLoading ? "Disconnecting..." : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
