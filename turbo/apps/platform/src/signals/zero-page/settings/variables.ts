import { command, state } from "ccstate";

// ---------------------------------------------------------------------------
// Dialog state
// ---------------------------------------------------------------------------

interface DialogState {
  open: boolean;
  mode: "add" | "edit";
}

const internalDialogState$ = state<DialogState>({
  open: false,
  mode: "add",
});

// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------

const internalFormValues$ = state({
  name: "",
  value: "",
  description: "",
});

// ---------------------------------------------------------------------------
// Form errors
// ---------------------------------------------------------------------------

const internalFormErrors$ = state<Record<string, string>>({});

// ---------------------------------------------------------------------------
// Commands: dialog open/close
// ---------------------------------------------------------------------------

export const openAddVariableDialog$ = command(
  ({ set }, prefillName?: string) => {
    set(internalFormValues$, {
      name: prefillName ?? "",
      value: "",
      description: "",
    });
    set(internalFormErrors$, {});
    set(internalDialogState$, {
      open: true,
      mode: "add",
    });
  },
);
