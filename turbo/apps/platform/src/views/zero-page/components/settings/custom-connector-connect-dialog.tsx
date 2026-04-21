import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";
import { Input } from "@vm0/ui/components/ui/input";
import {
  closeCustomConnectorDialog$,
  customConnectorConnectInput$,
  resetCustomConnectorConnectInput$,
  setCustomConnectorConnectInput$,
  setCustomConnectorSecret$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";

export function CustomConnectorConnectDialog({
  id,
  displayName,
}: {
  id: string;
  displayName: string;
}) {
  const value = useGet(customConnectorConnectInput$);
  const setValue = useSet(setCustomConnectorConnectInput$);
  const resetValue = useSet(resetCustomConnectorConnectInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [loadable, submit] = useLoadableSet(setCustomConnectorSecret$);
  const signal = useGet(pageSignal$);

  const submitting = loadable.state === "loading";
  const canSubmit = !submitting && value.length > 0;

  const close = () => {
    resetValue();
    closeDialog();
  };

  const onSubmit = () => {
    if (!canSubmit) {
      return;
    }
    detach(
      submit({ id, value }, signal).then(() => {
        close();
      }),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && close();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <CustomConnectorIcon id={id} displayName={displayName} size={20} />
            <DialogTitle>Connect {displayName}</DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Your credential is encrypted at rest and injected into outbound
          requests by the firewall. It&apos;s never exposed to the agent as an
          environment variable.
        </p>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="cc-connect-credential"
            className="text-sm font-medium text-foreground"
          >
            Credential
          </label>
          <Input
            id="cc-connect-credential"
            type="password"
            value={value}
            onChange={(e) => {
              return setValue(e.target.value);
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
