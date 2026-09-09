import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  connectorConnectionProgressVisible$,
  dismissConnectorConnectionProgress$,
} from "../../signals/connector-connection-progress.ts";
import { ConnectorConnectionStatus } from "./connector-connection-dialog-body.tsx";

export function ConnectorConnectionProgress() {
  const visible = useGet(connectorConnectionProgressVisible$);
  const dismiss = useSet(dismissConnectorConnectionProgress$);
  const { t } = useTranslation();

  return (
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        if (!open) {
          dismiss();
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.connectionProgress.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <ConnectorConnectionStatus />
      </DialogContent>
    </Dialog>
  );
}
