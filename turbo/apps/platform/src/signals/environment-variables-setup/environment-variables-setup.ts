import { command, computed, state } from "ccstate";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type SecretListResponse,
  type VariableListResponse,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { searchParams$ } from "../route.ts";
import { connectors$ } from "../external/connectors.ts";

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

// ---------------------------------------------------------------------------
// Env var → connector type mapping
// ---------------------------------------------------------------------------

function buildEnvVarToConnectorMap(): Readonly<Record<string, ConnectorType>> {
  const map: Record<string, ConnectorType> = {};
  for (const [type, config] of Object.entries(CONNECTOR_TYPES)) {
    for (const envVar of Object.keys(config.environmentMapping)) {
      map[envVar] = type as ConnectorType;
    }
  }
  return Object.freeze(map);
}

const ENV_VAR_TO_CONNECTOR = buildEnvVarToConnectorMap();

// ---------------------------------------------------------------------------
// Missing items (required minus existing)
// ---------------------------------------------------------------------------

const missingItems$ = computed(async (get) => {
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
// Connector items (missing secrets providable by connectors)
// ---------------------------------------------------------------------------

export interface ConnectorItem {
  connectorType: ConnectorType;
  label: string;
  helpText: string;
  connected: boolean;
  envVars: string[];
}

export const connectorItems$ = computed(async (get) => {
  const missing = await get(missingItems$);
  const { connectors } = await get(connectors$);
  const connectedTypes = new Set(connectors.map((c) => c.type));

  // Group missing items by connector type
  const grouped: Partial<Record<ConnectorType, string[]>> = {};
  for (const item of missing) {
    const connType = ENV_VAR_TO_CONNECTOR[item.name];
    if (connType) {
      const list = grouped[connType] ?? [];
      list.push(item.name);
      grouped[connType] = list;
    }
  }

  const result: ConnectorItem[] = [];
  for (const [connType, envVars] of Object.entries(grouped) as [
    ConnectorType,
    string[],
  ][]) {
    const config = CONNECTOR_TYPES[connType];
    result.push({
      connectorType: connType,
      label: config.label,
      helpText: config.helpText,
      connected: connectedTypes.has(connType),
      envVars,
    });
  }

  return result;
});

// ---------------------------------------------------------------------------
// Manual items (missing items NOT providable by any connector)
// ---------------------------------------------------------------------------

export const manualItems$ = computed(async (get) => {
  const missing = await get(missingItems$);
  return missing.filter((item) => !(item.name in ENV_VAR_TO_CONNECTOR));
});

// ---------------------------------------------------------------------------
// All connectors satisfied
// ---------------------------------------------------------------------------

export const allConnectorsSatisfied$ = computed(async (get) => {
  const items = await get(connectorItems$);
  return items.every((item) => item.connected);
});

// ---------------------------------------------------------------------------
// Auto-success: no manual items + all connectors connected
// ---------------------------------------------------------------------------

export const autoSuccess$ = computed(async (get) => {
  const manual = await get(manualItems$);
  if (manual.length > 0) {
    return false;
  }
  const connectorItemsList = await get(connectorItems$);
  if (connectorItemsList.length === 0) {
    return false;
  }
  return connectorItemsList.every((item) => item.connected);
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
    const connectorsSatisfied = await get(allConnectorsSatisfied$);
    signal.throwIfAborted();
    if (!connectorsSatisfied) {
      return;
    }

    const manual = await get(manualItems$);
    signal.throwIfAborted();
    const values = get(internalFormValues$);

    // Validate all manual fields have values
    const errors: Record<string, string> = {};
    for (const item of manual) {
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

      // Submit only manual items
      const requests = manual.map((item) => {
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
