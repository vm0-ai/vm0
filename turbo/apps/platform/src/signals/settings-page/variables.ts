import { command, computed, state } from "ccstate";
import type {
  VariableListResponse,
  VariableResponse,
  SetVariableRequest,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { requiredItems$ } from "./settings-tabs.ts";

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

const internalReloadVariables$ = state(0);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export const variables$ = computed(async (get) => {
  get(internalReloadVariables$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/variables");
  const data = (await resp.json()) as VariableListResponse;
  return data.variables.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
});

/**
 * Variables from `required` URL param that are not yet configured.
 */
export const missingVariables$ = computed(async (get) => {
  const required = get(requiredItems$);
  if (required.length === 0) {
    return [];
  }
  const existing = await get(variables$);
  const existingNames = new Set(existing.map((v) => v.name));
  return required.filter((name) => !existingNames.has(name));
});

// ---------------------------------------------------------------------------
// Dialog state
// ---------------------------------------------------------------------------

interface DialogState {
  open: boolean;
  mode: "add" | "edit";
  editingVariable: VariableResponse | null;
}

const internalDialogState$ = state<DialogState>({
  open: false,
  mode: "add",
  editingVariable: null,
});

export const variableDialogState$ = computed((get) =>
  get(internalDialogState$),
);

// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------

interface VariableFormValues {
  name: string;
  value: string;
  description: string;
}

const internalFormValues$ = state<VariableFormValues>({
  name: "",
  value: "",
  description: "",
});

export const variableFormValues$ = computed((get) => get(internalFormValues$));

// ---------------------------------------------------------------------------
// Form errors
// ---------------------------------------------------------------------------

const internalFormErrors$ = state<Record<string, string>>({});

export const variableFormErrors$ = computed((get) => get(internalFormErrors$));

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalActionPromise$ = state<Promise<unknown> | null>(null);

export const variableActionPromise$ = computed((get) =>
  get(internalActionPromise$),
);

// ---------------------------------------------------------------------------
// Delete dialog state
// ---------------------------------------------------------------------------

interface DeleteDialogState {
  open: boolean;
  variableName: string | null;
}

const internalDeleteDialogState$ = state<DeleteDialogState>({
  open: false,
  variableName: null,
});

export const variableDeleteDialogState$ = computed((get) =>
  get(internalDeleteDialogState$),
);

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
      editingVariable: null,
    });
  },
);

export const openEditVariableDialog$ = command(
  ({ set }, variable: VariableResponse) => {
    set(internalFormValues$, {
      name: variable.name,
      value: variable.value,
      description: variable.description ?? "",
    });
    set(internalFormErrors$, {});
    set(internalDialogState$, {
      open: true,
      mode: "edit",
      editingVariable: variable,
    });
  },
);

export const closeVariableDialog$ = command(({ set }) => {
  set(internalDialogState$, {
    open: false,
    mode: "add",
    editingVariable: null,
  });
  set(internalFormValues$, { name: "", value: "", description: "" });
  set(internalFormErrors$, {});
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const updateVariableFormName$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, name: value }));
  set(internalFormErrors$, (prev) => {
    const next = { ...prev };
    delete next["name"];
    return next;
  });
});

export const updateVariableFormValue$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, value }));
  set(internalFormErrors$, (prev) => {
    const next = { ...prev };
    delete next["value"];
    return next;
  });
});

export const updateVariableFormDescription$ = command(
  ({ set }, value: string) => {
    set(internalFormValues$, (prev) => ({ ...prev, description: value }));
  },
);

// ---------------------------------------------------------------------------
// Commands: submit
// ---------------------------------------------------------------------------

export const submitVariableDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialogState = get(internalDialogState$);
    const formValues = get(internalFormValues$);

    const errors: Record<string, string> = {};

    if (dialogState.mode === "add") {
      if (!formValues.name.trim()) {
        errors["name"] = "Variable name is required";
      } else if (!/^[A-Z][A-Z0-9_]*$/.test(formValues.name)) {
        errors["name"] =
          "Must contain only uppercase letters, numbers, and underscores, starting with a letter";
      }
    }

    if (!formValues.value) {
      errors["value"] = "Variable value is required";
    }

    if (Object.keys(errors).length > 0) {
      set(internalFormErrors$, errors);
      return;
    }

    const body: SetVariableRequest = {
      name:
        dialogState.mode === "edit"
          ? dialogState.editingVariable!.name
          : formValues.name,
      value: formValues.value,
      ...(formValues.description.trim()
        ? { description: formValues.description.trim() }
        : {}),
    };

    const promise = (async () => {
      const fetchFn = get(fetch$);
      const response = await fetchFn("/api/variables", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to save variable: ${response.status}`);
      }

      signal.throwIfAborted();
      set(internalReloadVariables$, (x) => x + 1);
      set(internalDialogState$, {
        open: false,
        mode: "add",
        editingVariable: null,
      });
      set(internalFormValues$, { name: "", value: "", description: "" });
      set(internalFormErrors$, {});
    })();

    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Commands: delete
// ---------------------------------------------------------------------------

export const openDeleteVariableDialog$ = command(
  ({ set }, variableName: string) => {
    set(internalDeleteDialogState$, { open: true, variableName });
  },
);

export const closeDeleteVariableDialog$ = command(({ set }) => {
  set(internalDeleteDialogState$, { open: false, variableName: null });
});

export const confirmDeleteVariable$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const deleteState = get(internalDeleteDialogState$);
    if (!deleteState.variableName) {
      return;
    }

    const promise = (async () => {
      const fetchFn = get(fetch$);
      const response = await fetchFn(
        `/api/variables/${encodeURIComponent(deleteState.variableName!)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error(`Failed to delete variable: ${response.status}`);
      }

      signal.throwIfAborted();
      set(internalReloadVariables$, (x) => x + 1);
      set(internalDeleteDialogState$, { open: false, variableName: null });
    })();

    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
