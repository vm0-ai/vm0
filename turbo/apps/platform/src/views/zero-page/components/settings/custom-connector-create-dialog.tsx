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

function CreateFormFields({
  form,
  setField,
}: {
  form: {
    displayName: string;
    prefixesRaw: string;
    headerName: string;
    headerTemplate: string;
  };
  setField: (
    field: "displayName" | "prefixesRaw" | "headerName" | "headerTemplate",
    value: string,
  ) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-display-name"
          className="text-sm font-medium text-foreground"
        >
          Display name
        </label>
        <Input
          id="cc-display-name"
          value={form.displayName}
          onChange={(e) => {
            return setField("displayName", e.target.value);
          }}
          placeholder="Acme API"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-prefixes"
          className="text-sm font-medium text-foreground"
        >
          Prefixes
          <span className="text-muted-foreground font-normal ml-1">
            (one per line, https only)
          </span>
        </label>
        <textarea
          id="cc-prefixes"
          value={form.prefixesRaw}
          onChange={(e) => {
            return setField("prefixesRaw", e.target.value);
          }}
          placeholder="https://api.acme.com/v1/"
          rows={3}
          className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[72px]"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-header-name"
          className="text-sm font-medium text-foreground"
        >
          Header name
        </label>
        <Input
          id="cc-header-name"
          value={form.headerName}
          onChange={(e) => {
            return setField("headerName", e.target.value);
          }}
          placeholder="Authorization"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="cc-header-template"
          className="text-sm font-medium text-foreground"
        >
          Header template
          <span className="text-muted-foreground font-normal ml-1">
            (must contain {`{{secret}}`})
          </span>
        </label>
        <Input
          id="cc-header-template"
          value={form.headerTemplate}
          onChange={(e) => {
            return setField("headerTemplate", e.target.value);
          }}
          placeholder="Bearer {{secret}}"
        />
      </div>
    </div>
  );
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
      (async () => {
        await submit(
          {
            displayName: form.displayName.trim(),
            prefixes,
            headerName: form.headerName.trim(),
            headerTemplate: form.headerTemplate,
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
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New custom connector</DialogTitle>
        </DialogHeader>
        <CreateFormFields form={form} setField={setField} />
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
