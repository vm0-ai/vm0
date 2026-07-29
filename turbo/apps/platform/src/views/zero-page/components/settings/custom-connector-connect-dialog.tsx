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
  customConnectorConnectInput$,
  resetCustomConnectorConnectInput$,
  setCustomConnectorConnectInput$,
  setCustomConnectorSecret$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { hasTokenInputValue } from "../../../../signals/zero-page/settings/token-input.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import type { FormEvent } from "react";

export function CustomConnectorConnectDialog({
  id,
  displayName,
}: {
  id: string;
  displayName: string;
}) {
  const { t } = useTranslation();
  const value = useGet(customConnectorConnectInput$);
  const setValue = useSet(setCustomConnectorConnectInput$);
  const resetValue = useSet(resetCustomConnectorConnectInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [loadable, submit] = useLoadableSet(setCustomConnectorSecret$);
  const signal = useGet(pageSignal$);

  const submitting = loadable.state === "loading";
  const canSubmit = !submitting && hasTokenInputValue(value);

  const close = () => {
    resetValue();
    closeDialog();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    detach(
      (async () => {
        await submit({ id, value }, signal);
        close();
      })(),
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
            <DialogTitle>
              {t(
                ($) => {
                  return $.connectors.custom.connect.title;
                },
                { connector: displayName },
              )}
            </DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.custom.connect.description;
          })}
        </p>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="cc-connect-secret"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.connectors.custom.connect.secret;
              })}
            </label>
            <Input
              id="cc-connect-secret"
              type="password"
              value={value}
              onChange={(e) => {
                return setValue(e.target.value);
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
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
