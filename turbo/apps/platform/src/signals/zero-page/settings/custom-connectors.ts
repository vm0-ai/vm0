import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorValuesContract,
  zeroCustomConnectorsContract,
  type CustomConnectorFieldKind,
  type CustomConnectorResponse,
  type CustomConnectorValueInput,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../api-client.ts";
import { sanitizeTokenInput } from "./token-input.ts";

const internalReload$ = state(0);

function normaliseCustomConnectorResponse(
  connector: CustomConnectorResponse,
): CustomConnectorResponse {
  return {
    ...connector,
    // Deployment compatibility: older API responses only had hasSecret.
    // Delete this with the hasSecret compatibility field in #20281.
    connected: connector.connected || connector.hasSecret,
  };
}

// ---------------------------------------------------------------------------
// Active tab on the Connectors settings page
// ---------------------------------------------------------------------------

const internalTab$ = state<"builtin" | "custom">("builtin");
export const connectorsPageTab$ = computed((get) => {
  return get(internalTab$);
});
export const setConnectorsPageTab$ = command(
  ({ set }, tab: "builtin" | "custom") => {
    set(internalTab$, tab);
  },
);

/**
 * List of org custom connectors with per-caller connection state.
 * Cache-busted by `reloadCustomConnectors$`.
 */
export const customConnectors$ = computed(
  async (get): Promise<CustomConnectorResponse[]> => {
    get(internalReload$);
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorsContract);
    const result = await accept(client.list(), [200]);
    return result.body.connectors.map(normaliseCustomConnectorResponse);
  },
);

const bumpReload$ = command(({ set }) => {
  set(internalReload$, (v) => {
    return v + 1;
  });
});

export const createCustomConnector$ = command(
  async (
    { get, set },
    body: {
      displayName: string;
      prefixes: string[];
      headerName: string;
      headerTemplate: string;
    },
    _signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorsContract);
    const result = await accept(
      client.create({
        body,
        fetchOptions: { signal: _signal },
      }),
      [201],
    );
    set(bumpReload$);
    toast.success(`Created "${result.body.displayName}"`);
    return result.body;
  },
);

export const deleteCustomConnector$ = command(
  async ({ get, set }, id: string, _signal: AbortSignal): Promise<void> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorByIdContract);
    await accept(
      client.delete({
        params: { id },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );
    set(bumpReload$);
    toast.success("Custom connector deleted");
  },
);

export const renameCustomConnector$ = command(
  async (
    { get, set },
    args: { id: string; displayName: string },
    _signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorByIdContract);
    const result = await accept(
      client.patch({
        params: { id: args.id },
        body: { displayName: args.displayName },
        fetchOptions: { signal: _signal },
      }),
      [200],
    );
    set(bumpReload$);
    toast.success(`Renamed to "${result.body.displayName}"`);
    return result.body;
  },
);

function sanitizeCustomConnectorValue(
  value: CustomConnectorValueInput,
): CustomConnectorValueInput {
  return {
    ...value,
    value:
      value.kind === "secret"
        ? sanitizeTokenInput(value.value)
        : value.value.trim(),
  };
}

export const setCustomConnectorValues$ = command(
  async (
    { get, set },
    args: { id: string; values: readonly CustomConnectorValueInput[] },
    _signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorValuesContract);
    const values = args.values
      .map(sanitizeCustomConnectorValue)
      .filter((value) => {
        return value.value.length > 0;
      });
    const result = await accept(
      client.set({
        params: { id: args.id },
        body: { values },
        fetchOptions: { signal: _signal },
      }),
      [200],
    );
    set(bumpReload$);
    toast.success(
      result.body.connected ? "Connected" : "Connector values saved",
    );
    return result.body;
  },
);

export const clearCustomConnectorValues$ = command(
  async ({ get, set }, id: string, _signal: AbortSignal): Promise<void> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorValuesContract);
    await accept(
      client.delete({
        params: { id },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );
    set(bumpReload$);
    toast.success("Disconnected");
  },
);

// ---------------------------------------------------------------------------
// Settings page dialog state — tracks which dialog is open.
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "rename"; connector: CustomConnectorResponse }
  | { kind: "connect"; connector: CustomConnectorResponse }
  | { kind: "delete"; connector: CustomConnectorResponse };

const internalDialog$ = state<DialogState>({ kind: "none" });
export const customConnectorDialog$ = computed((get) => {
  return get(internalDialog$);
});
export const openCustomConnectorCreateDialog$ = command(({ set }) => {
  set(internalDialog$, { kind: "create" });
});
export const openCustomConnectorRenameDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "rename", connector });
  },
);
export const openCustomConnectorConnectDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "connect", connector });
  },
);
export const openCustomConnectorDeleteDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "delete", connector });
  },
);
export const closeCustomConnectorDialog$ = command(({ set }) => {
  set(internalDialog$, { kind: "none" });
});

// ---------------------------------------------------------------------------
// Create form state
// ---------------------------------------------------------------------------

interface CustomConnectorCreateForm {
  displayName: string;
  prefixesRaw: string;
  headerName: string;
  headerTemplate: string;
}

const CREATE_FORM_DEFAULTS = {
  displayName: "",
  prefixesRaw: "",
  headerName: "Authorization",
  headerTemplate: "Bearer {{secret}}",
} as const satisfies CustomConnectorCreateForm;

const internalCreateForm$ =
  state<CustomConnectorCreateForm>(CREATE_FORM_DEFAULTS);
export const customConnectorCreateForm$ = computed((get) => {
  return get(internalCreateForm$);
});
export const setCustomConnectorCreateField$ = command(
  ({ get, set }, field: keyof CustomConnectorCreateForm, value: string) => {
    const prev = get(internalCreateForm$);
    set(internalCreateForm$, { ...prev, [field]: value });
  },
);
export const resetCustomConnectorCreateForm$ = command(({ set }) => {
  set(internalCreateForm$, CREATE_FORM_DEFAULTS);
});

// ---------------------------------------------------------------------------
// Rename form state
// ---------------------------------------------------------------------------

const internalRenameInput$ = state("");
export const customConnectorRenameInput$ = computed((get) => {
  return get(internalRenameInput$);
});
export const setCustomConnectorRenameInput$ = command(
  ({ set }, value: string) => {
    set(internalRenameInput$, value);
  },
);

// ---------------------------------------------------------------------------
// Connect form state
// ---------------------------------------------------------------------------

export type CustomConnectorConnectInput = Readonly<Record<string, string>>;

export function customConnectorFieldMarker(args: {
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}): string {
  return `${args.kind}:${args.key}`;
}

const internalConnectInput$ = state<CustomConnectorConnectInput>({});
export const customConnectorConnectInput$ = computed((get) => {
  return get(internalConnectInput$);
});
export const setCustomConnectorConnectField$ = command(
  (
    { get, set },
    args: {
      readonly kind: CustomConnectorFieldKind;
      readonly key: string;
      readonly value: string;
    },
  ) => {
    const previous = get(internalConnectInput$);
    set(internalConnectInput$, {
      ...previous,
      [customConnectorFieldMarker(args)]: args.value,
    });
  },
);
export const resetCustomConnectorConnectInput$ = command(({ set }) => {
  set(internalConnectInput$, {});
});
