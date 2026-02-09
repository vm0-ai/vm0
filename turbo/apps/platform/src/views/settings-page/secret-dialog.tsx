import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  secretDialogState$,
  secretFormValues$,
  secretFormErrors$,
  secretActionPromise$,
  closeSecretDialog$,
  updateSecretFormName$,
  updateSecretFormValue$,
  updateSecretFormDescription$,
  submitSecretDialog$,
} from "../../signals/settings-page/secrets.ts";

export function SecretDialog() {
  const dialog = useGet(secretDialogState$);
  const formValues = useGet(secretFormValues$);
  const errors = useGet(secretFormErrors$);
  const actionStatus = useLoadable(secretActionPromise$);
  const close = useSet(closeSecretDialog$);
  const setName = useSet(updateSecretFormName$);
  const setValue = useSet(updateSecretFormValue$);
  const setDescription = useSet(updateSecretFormDescription$);
  const submit = useSet(submitSecretDialog$);
  const pageSignal = useGet(pageSignal$);

  const isLoading = actionStatus.state === "loading";
  const isEdit = dialog.mode === "edit";

  const handleSubmit = () => {
    detach(submit(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog open={dialog.open} onOpenChange={() => close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-normal leading-7">
            {isEdit ? "Edit secret" : "Add secret"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the secret value or description"
              : "Add an encrypted secret for your agents to use"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Name</label>
            {isEdit ? (
              <div className="text-sm font-mono text-foreground px-3 py-2 rounded-md border border-border bg-muted">
                {dialog.editingSecret?.name}
              </div>
            ) : (
              <>
                <Input
                  value={formValues.name}
                  placeholder="MY_API_KEY"
                  onChange={(e) => setName(e.target.value.toUpperCase())}
                  readOnly={isLoading}
                  className={`font-mono ${errors["name"] ? "border-destructive" : ""}`}
                />
                {errors["name"] && (
                  <p className="text-xs text-destructive">{errors["name"]}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Uppercase letters, numbers, and underscores only
                </p>
              </>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Value</label>
            <Input
              type="password"
              value={formValues.value}
              placeholder={isEdit ? "Enter new value" : "Enter secret value"}
              onChange={(e) => setValue(e.target.value)}
              readOnly={isLoading}
              className={errors["value"] ? "border-destructive" : ""}
            />
            {errors["value"] && (
              <p className="text-xs text-destructive">{errors["value"]}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">
              Description
              <span className="text-muted-foreground font-normal">
                {" "}
                (optional)
              </span>
            </label>
            <Input
              value={formValues.description}
              placeholder="What is this secret used for?"
              onChange={(e) => setDescription(e.target.value)}
              readOnly={isLoading}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => close()}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? "Saving..." : isEdit ? "Save changes" : "Add secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
