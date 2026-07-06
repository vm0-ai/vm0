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
  customConnectorFieldMarker,
  customConnectorConnectInput$,
  resetCustomConnectorConnectInput$,
  setCustomConnectorConnectField$,
  setCustomConnectorValues$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { hasTokenInputValue } from "../../../../signals/zero-page/settings/token-input.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import type {
  CustomConnectorField,
  CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { FormEvent } from "react";

function hasCustomConnectorFieldValue(
  field: CustomConnectorField,
  value: string | undefined,
): boolean {
  if (field.kind === "secret") {
    return hasTokenInputValue(value);
  }
  return value !== undefined && value.trim().length > 0;
}

export function CustomConnectorConnectDialog({
  connector,
}: {
  connector: CustomConnectorResponse;
}) {
  const values = useGet(customConnectorConnectInput$);
  const setFieldValue = useSet(setCustomConnectorConnectField$);
  const resetValue = useSet(resetCustomConnectorConnectInput$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const [loadable, submit] = useLoadableSet(setCustomConnectorValues$);
  const signal = useGet(pageSignal$);

  const submitting = loadable.state === "loading";
  const canSubmit =
    !submitting &&
    connector.fields.every((field) => {
      return (
        !field.required ||
        hasCustomConnectorFieldValue(
          field,
          values[customConnectorFieldMarker(field)],
        )
      );
    });

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
        await submit(
          {
            id: connector.id,
            values: connector.fields.map((field) => {
              return {
                kind: field.kind,
                key: field.key,
                value: values[customConnectorFieldMarker(field)] ?? "",
              };
            }),
          },
          signal,
        );
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
            <CustomConnectorIcon
              id={connector.id}
              displayName={connector.displayName}
              size={20}
            />
            <DialogTitle>Connect {connector.displayName}</DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Connector values are encrypted at rest and injected into outbound
          requests by the firewall. They&apos;re never exposed to the agent as
          environment variables.
        </p>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          {connector.fields.map((field, index) => {
            const marker = customConnectorFieldMarker(field);
            const inputId = `cc-connect-${field.kind}-${field.key}`;
            return (
              <div key={marker} className="flex flex-col gap-2">
                <label
                  htmlFor={inputId}
                  className="text-sm font-medium text-foreground"
                >
                  {field.label}
                </label>
                <Input
                  id={inputId}
                  type={field.kind === "secret" ? "password" : "text"}
                  value={values[marker] ?? ""}
                  onChange={(e) => {
                    return setFieldValue({
                      kind: field.kind,
                      key: field.key,
                      value: e.target.value,
                    });
                  }}
                  autoFocus={index === 0}
                />
                {field.description && (
                  <p className="text-xs text-muted-foreground">
                    {field.description}
                  </p>
                )}
              </div>
            );
          })}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
