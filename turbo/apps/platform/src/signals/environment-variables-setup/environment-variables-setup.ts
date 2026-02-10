import { command, computed, state } from "ccstate";
import type { SecretListResponse, VariableListResponse } from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { searchParams$ } from "../route.ts";

// ---------------------------------------------------------------------------
// URL params parsing
// ---------------------------------------------------------------------------

const internalRequiredSecrets$ = state<string[]>([]);
const internalRequiredVars$ = state<string[]>([]);

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

const internalReload$ = state(0);

// ---------------------------------------------------------------------------
// Existing items (fetched from API)
// ---------------------------------------------------------------------------

const existingSecretNames$ = computed(async (get) => {
  get(internalReload$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/secrets");
  const data = (await resp.json()) as SecretListResponse;
  return new Set(
    data.secrets.filter((s) => s.type !== "model-provider").map((s) => s.name),
  );
});

const existingVariableNames$ = computed(async (get) => {
  get(internalReload$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/variables");
  const data = (await resp.json()) as VariableListResponse;
  return new Set(data.variables.map((v) => v.name));
});

// ---------------------------------------------------------------------------
// Missing items (required minus existing)
// ---------------------------------------------------------------------------

interface MissingItem {
  name: string;
  type: "secret" | "variable";
}

export const missingItems$ = computed(async (get) => {
  const requiredSecrets = get(internalRequiredSecrets$);
  const requiredVars = get(internalRequiredVars$);

  if (requiredSecrets.length === 0 && requiredVars.length === 0) {
    return [];
  }

  const existingSecrets = await get(existingSecretNames$);
  const existingVars = await get(existingVariableNames$);

  const missing: MissingItem[] = [];

  for (const name of requiredSecrets) {
    if (!existingSecrets.has(name)) {
      missing.push({ name, type: "secret" });
    }
  }

  for (const name of requiredVars) {
    if (!existingVars.has(name)) {
      missing.push({ name, type: "variable" });
    }
  }

  return missing;
});

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

const internalFormValues$ = state<Record<string, string>>({});
const internalFormErrors$ = state<Record<string, string>>({});

export const formValues$ = computed((get) => get(internalFormValues$));
export const formErrors$ = computed((get) => get(internalFormErrors$));

// ---------------------------------------------------------------------------
// Success state
// ---------------------------------------------------------------------------

const internalIsSuccess$ = state(false);

export const isSuccess$ = computed((get) => get(internalIsSuccess$));

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalSubmitPromise$ = state<Promise<unknown> | null>(null);

export const submitPromise$ = computed((get) => get(internalSubmitPromise$));

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const updateFormValue$ = command(
  ({ set }, name: string, value: string) => {
    set(internalFormValues$, (prev) => ({ ...prev, [name]: value }));
    set(internalFormErrors$, (prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  },
);

// ---------------------------------------------------------------------------
// Commands: submit
// ---------------------------------------------------------------------------

export const submitForm$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const missing = await get(missingItems$);
    signal.throwIfAborted();
    const values = get(internalFormValues$);

    // Validate all fields have values
    const errors: Record<string, string> = {};
    for (const item of missing) {
      if (!values[item.name]?.trim()) {
        errors[item.name] = `${item.name} is required`;
      }
    }

    if (Object.keys(errors).length > 0) {
      set(internalFormErrors$, errors);
      return;
    }

    const promise = (async () => {
      const fetchFn = get(fetch$);

      // Submit all items in parallel
      const requests = missing.map((item) => {
        const endpoint =
          item.type === "secret" ? "/api/secrets" : "/api/variables";
        return fetchFn(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: item.name, value: values[item.name] }),
        });
      });

      const responses = await Promise.all(requests);

      for (const response of responses) {
        if (!response.ok) {
          throw new Error(`Failed to save: ${response.status}`);
        }
      }

      signal.throwIfAborted();
      set(internalIsSuccess$, true);
    })();

    set(internalSubmitPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalSubmitPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------

function parseCommaSeparated(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const initEnvironmentVariablesSetup$ = command(({ get, set }) => {
  const params = get(searchParams$);

  set(internalRequiredSecrets$, parseCommaSeparated(params.get("secrets")));
  set(internalRequiredVars$, parseCommaSeparated(params.get("vars")));
  set(internalFormValues$, {});
  set(internalFormErrors$, {});
  set(internalIsSuccess$, false);
  set(internalSubmitPromise$, null);
});
