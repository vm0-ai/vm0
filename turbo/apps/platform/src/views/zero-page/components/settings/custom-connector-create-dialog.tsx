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
  createCustomConnector$,
  customConnectorCreateForm$,
  resetCustomConnectorCreateForm$,
  setCustomConnectorCreateField$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";

function parsePrefixLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .filter((line) => {
      return line.length > 0;
    });
}

export function CustomConnectorCreateDialog() {
  const form = useGet(customConnectorCreateForm$);
  const setField = useSet(setCustomConnectorCreateField$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  const resetForm = useSet(resetCustomConnectorCreateForm$);
  const [loadable, submit] = useLoadableSet(createCustomConnector$);
  const signal = useGet(pageSignal$);

  const submitting = loadable.state === "loading";
  const prefixes = parsePrefixLines(form.prefixesRaw);
  const canSubmit =
    !submitting &&
    form.displayName.trim().length > 0 &&
    prefixes.length > 0 &&
    form.headerName.trim().length > 0 &&
    form.headerTemplate.includes("{{secret}}");

  const close = () => {
    resetForm();
    closeDialog();
  };

  const onSubmit = () => {
    if (!canSubmit) {
      return;
    }
    detach(
      submit(
        {
          displayName: form.displayName.trim(),
          prefixes,
          headerName: form.headerName.trim(),
          headerTemplate: form.headerTemplate,
        },
        signal,
      ).then(() => {
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
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New custom connector</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-foreground">Display name</span>
            <Input
              value={form.displayName}
              onChange={(e) => {
                return setField("displayName", e.target.value);
              }}
              placeholder="Acme API"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-foreground">
              Prefixes{" "}
              <span className="text-muted-foreground">
                (one per line, https only)
              </span>
            </span>
            <textarea
              value={form.prefixesRaw}
              onChange={(e) => {
                return setField("prefixesRaw", e.target.value);
              }}
              placeholder="https://api.acme.com/v1/"
              rows={3}
              className="flex min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-foreground">Header name</span>
            <Input
              value={form.headerName}
              onChange={(e) => {
                return setField("headerName", e.target.value);
              }}
              placeholder="Authorization"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-foreground">
              Header template{" "}
              <span className="text-muted-foreground">
                (must contain {`{{secret}}`})
              </span>
            </span>
            <Input
              value={form.headerTemplate}
              onChange={(e) => {
                return setField("headerTemplate", e.target.value);
              }}
              placeholder="Bearer {{secret}}"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
