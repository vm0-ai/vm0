import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
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
import type { FormEvent } from "react";

export function CustomConnectorRenameDialog({
  id,
  currentDisplayName,
}: {
  id: string;
  currentDisplayName: string;
}) {
  const { t } = useTranslation();
  const displayName = useGet(customConnectorRenameInput$);
  const setDisplayName = useSet(setCustomConnectorRenameInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [loadable, submit] = useLoadableSet(renameCustomConnector$);
  const signal = useGet(pageSignal$);

  const submitting = loadable.state === "loading";
  const trimmed = displayName.trim();
  const canSubmit =
    !submitting && trimmed.length > 0 && trimmed !== currentDisplayName;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    detach(
      (async () => {
        await submit({ id, displayName: trimmed }, signal);
        closeDialog();
      })(),
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
          <DialogTitle>
            {t(($) => {
              return $.connectors.custom.rename.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="cc-rename-name"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.connectors.custom.rename.displayName;
              })}
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
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={submitting}
            >
              {t(($) => {
                return $.connectors.actions.cancel;
              })}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting
                ? t(($) => {
                    return $.connectors.actions.savingEllipsis;
                  })
                : t(($) => {
                    return $.connectors.actions.save;
                  })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
