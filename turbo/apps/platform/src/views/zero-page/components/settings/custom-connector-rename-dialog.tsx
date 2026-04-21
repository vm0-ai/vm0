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
  customConnectorRenameInput$,
  renameCustomConnector$,
  setCustomConnectorRenameInput$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";

export function CustomConnectorRenameDialog({
  id,
  currentDisplayName,
}: {
  id: string;
  currentDisplayName: string;
}) {
  const displayName = useGet(customConnectorRenameInput$);
  const setDisplayName = useSet(setCustomConnectorRenameInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [loadable, submit] = useLoadableSet(renameCustomConnector$);
  const signal = useGet(pageSignal$);

  const submitting = loadable.state === "loading";
  const trimmed = displayName.trim();
  const canSubmit =
    !submitting && trimmed.length > 0 && trimmed !== currentDisplayName;

  const onSubmit = () => {
    if (!canSubmit) {
      return;
    }
    detach(
      submit({ id, displayName: trimmed }, signal).then(() => {
        closeDialog();
      }),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && closeDialog();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Rename custom connector</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="cc-rename-name"
            className="text-sm font-medium text-foreground"
          >
            Display name
          </label>
          <Input
            id="cc-rename-name"
            value={displayName}
            onChange={(e) => {
              return setDisplayName(e.target.value);
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog} disabled={submitting}>
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
