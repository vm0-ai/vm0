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
  variableDialogState$,
  variableFormValues$,
  variableFormErrors$,
  variableActionPromise$,
  closeVariableDialog$,
  updateVariableFormName$,
  updateVariableFormValue$,
  updateVariableFormDescription$,
  submitVariableDialog$,
} from "../../signals/settings-page/variables.ts";

export function VariableDialog() {
  const dialog = useGet(variableDialogState$);
  const formValues = useGet(variableFormValues$);
  const errors = useGet(variableFormErrors$);
  const actionStatus = useLoadable(variableActionPromise$);
  const close = useSet(closeVariableDialog$);
  const setName = useSet(updateVariableFormName$);
  const setValue = useSet(updateVariableFormValue$);
  const setDescription = useSet(updateVariableFormDescription$);
  const submit = useSet(submitVariableDialog$);
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
            {isEdit ? "Edit variable" : "Add variable"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the variable value or description"
              : "Add a plaintext configuration variable for your agents"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Name</label>
            {isEdit ? (
              <div className="text-sm font-mono text-foreground px-3 py-2 rounded-md border border-border bg-muted">
                {dialog.editingVariable?.name}
              </div>
            ) : (
              <>
                <Input
                  value={formValues.name}
                  placeholder="MY_VARIABLE"
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
              value={formValues.value}
              placeholder="Enter variable value"
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
              placeholder="What is this variable used for?"
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
            {isLoading ? "Saving..." : isEdit ? "Save changes" : "Add variable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
