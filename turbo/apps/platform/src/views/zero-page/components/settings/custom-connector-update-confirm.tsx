import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  CustomConnectorResponse,
  UpdateCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeCustomConnectorDialog$,
  resetCustomConnectorCreateForm$,
  returnToCustomConnectorEditDialog$,
  updateCustomConnector$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export function CustomConnectorUpdateConfirm({
  connector,
  body,
}: {
  readonly connector: CustomConnectorResponse;
  readonly body: UpdateCustomConnectorBody;
}) {
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const resetForm = useSet(resetCustomConnectorCreateForm$);
  const returnToEdit = useSet(returnToCustomConnectorEditDialog$);
  const [loadable, updateConnector] = useLoadableSet(updateCustomConnector$);
  const signal = useGet(pageSignal$);
  const submitting = loadable.state === "loading";

  const cancel = () => {
    returnToEdit(connector);
  };

  const confirm = () => {
    detach(
      (async () => {
        await updateConnector({ id: connector.id, body }, signal);
        resetForm();
        closeDialog();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && cancel();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Disconnect existing OAuth connections?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          These OAuth changes will disconnect every member currently connected
          with OAuth. They&apos;ll need to connect this custom connector again.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={cancel} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting ? "Saving…" : "Save and disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
