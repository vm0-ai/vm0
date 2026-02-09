import { command, computed, state } from "ccstate";
import type {
  SecretListResponse,
  SecretResponse,
  SetSecretRequest,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { requiredItems$ } from "./settings-tabs.ts";

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

const internalReloadSecrets$ = state(0);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export const secrets$ = computed(async (get) => {
  get(internalReloadSecrets$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/secrets");
  const data = (await resp.json()) as SecretListResponse;
  // Filter out model-provider secrets (only show user and connector secrets)
  return data.secrets
    .filter((s) => s.type !== "model-provider")
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
});

/**
 * Secrets from `required` URL param that are not yet configured.
 */
export const missingSecrets$ = computed(async (get) => {
  const required = get(requiredItems$);
  if (required.length === 0) {
    return [];
  }
  const existing = await get(secrets$);
  const existingNames = new Set(existing.map((s) => s.name));
  return required.filter((name) => !existingNames.has(name));
});

// ---------------------------------------------------------------------------
// Dialog state
// ---------------------------------------------------------------------------

interface DialogState {
  open: boolean;
  mode: "add" | "edit";
  editingSecret: SecretResponse | null;
}

const internalDialogState$ = state<DialogState>({
  open: false,
  mode: "add",
  editingSecret: null,
});

export const secretDialogState$ = computed((get) => get(internalDialogState$));

// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------

interface SecretFormValues {
  name: string;
  value: string;
  description: string;
}

const internalFormValues$ = state<SecretFormValues>({
  name: "",
  value: "",
  description: "",
});

export const secretFormValues$ = computed((get) => get(internalFormValues$));

// ---------------------------------------------------------------------------
// Form errors
// ---------------------------------------------------------------------------

const internalFormErrors$ = state<Record<string, string>>({});

export const secretFormErrors$ = computed((get) => get(internalFormErrors$));

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalActionPromise$ = state<Promise<unknown> | null>(null);

export const secretActionPromise$ = computed((get) =>
  get(internalActionPromise$),
);

// ---------------------------------------------------------------------------
// Delete dialog state
// ---------------------------------------------------------------------------

interface DeleteDialogState {
  open: boolean;
  secretName: string | null;
}

const internalDeleteDialogState$ = state<DeleteDialogState>({
  open: false,
  secretName: null,
});

export const secretDeleteDialogState$ = computed((get) =>
  get(internalDeleteDialogState$),
);

// ---------------------------------------------------------------------------
// Commands: dialog open/close
// ---------------------------------------------------------------------------

export const openAddSecretDialog$ = command(({ set }, prefillName?: string) => {
  set(internalFormValues$, {
    name: prefillName ?? "",
    value: "",
    description: "",
  });
  set(internalFormErrors$, {});
  set(internalDialogState$, {
    open: true,
    mode: "add",
    editingSecret: null,
  });
});

export const openEditSecretDialog$ = command(
  ({ set }, secret: SecretResponse) => {
    set(internalFormValues$, {
      name: secret.name,
      value: "",
      description: secret.description ?? "",
    });
    set(internalFormErrors$, {});
    set(internalDialogState$, {
      open: true,
      mode: "edit",
      editingSecret: secret,
    });
  },
);

export const closeSecretDialog$ = command(({ set }) => {
  set(internalDialogState$, { open: false, mode: "add", editingSecret: null });
  set(internalFormValues$, { name: "", value: "", description: "" });
  set(internalFormErrors$, {});
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const updateSecretFormName$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, name: value }));
  set(internalFormErrors$, (prev) => {
    const next = { ...prev };
    delete next["name"];
    return next;
  });
});

export const updateSecretFormValue$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, value }));
  set(internalFormErrors$, (prev) => {
    const next = { ...prev };
    delete next["value"];
    return next;
  });
});

export const updateSecretFormDescription$ = command(
  ({ set }, value: string) => {
    set(internalFormValues$, (prev) => ({ ...prev, description: value }));
  },
);

// ---------------------------------------------------------------------------
// Commands: submit
// ---------------------------------------------------------------------------

export const submitSecretDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialogState = get(internalDialogState$);
    const formValues = get(internalFormValues$);

    const errors: Record<string, string> = {};

    // Validate name (add mode only)
    if (dialogState.mode === "add") {
      if (!formValues.name.trim()) {
        errors["name"] = "Secret name is required";
      } else if (!/^[A-Z][A-Z0-9_]*$/.test(formValues.name)) {
        errors["name"] =
          "Must contain only uppercase letters, numbers, and underscores, starting with a letter";
      }
    }

    // Validate value (required on add, optional on edit)
    if (dialogState.mode === "add" && !formValues.value) {
      errors["value"] = "Secret value is required";
    }

    if (Object.keys(errors).length > 0) {
      set(internalFormErrors$, errors);
      return;
    }

    const body: SetSecretRequest = {
      name:
        dialogState.mode === "edit"
          ? dialogState.editingSecret!.name
          : formValues.name,
      value: formValues.value,
      ...(formValues.description.trim()
        ? { description: formValues.description.trim() }
        : {}),
    };

    const promise = (async () => {
      const fetchFn = get(fetch$);
      const response = await fetchFn("/api/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to save secret: ${response.status}`);
      }

      signal.throwIfAborted();
      set(internalReloadSecrets$, (x) => x + 1);
      set(internalDialogState$, {
        open: false,
        mode: "add",
        editingSecret: null,
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

export const openDeleteSecretDialog$ = command(
  ({ set }, secretName: string) => {
    set(internalDeleteDialogState$, { open: true, secretName });
  },
);

export const closeDeleteSecretDialog$ = command(({ set }) => {
  set(internalDeleteDialogState$, { open: false, secretName: null });
});

export const confirmDeleteSecret$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const deleteState = get(internalDeleteDialogState$);
    if (!deleteState.secretName) {
      return;
    }

    const promise = (async () => {
      const fetchFn = get(fetch$);
      const response = await fetchFn(
        `/api/secrets/${encodeURIComponent(deleteState.secretName!)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error(`Failed to delete secret: ${response.status}`);
      }

      signal.throwIfAborted();
      set(internalReloadSecrets$, (x) => x + 1);
      set(internalDeleteDialogState$, { open: false, secretName: null });
    })();

    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
