import { useGet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { connectorConnectionPending$ } from "../../signals/connector-connection-progress.ts";
import { connectorOAuthDeviceAuthState$ } from "../../signals/okou-page/settings/connectors.ts";

export function ConnectorConnectionProgress() {
  const pending = useGet(connectorConnectionPending$);
  const deviceAuth = useGet(connectorOAuthDeviceAuthState$);
  const { t } = useTranslation();
  // The device dialog must remain usable for copying the code and opening approval.
  const deviceAuthorizationVisible =
    deviceAuth.status === "pending" || deviceAuth.status === "polling";

  return (
    <Dialog
      open={pending && !deviceAuthorizationVisible}
      onOpenChange={(_open, eventDetails) => {
        eventDetails.cancel();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.connectionProgress.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.connectors.connectionProgress.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center py-6" aria-hidden="true">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
