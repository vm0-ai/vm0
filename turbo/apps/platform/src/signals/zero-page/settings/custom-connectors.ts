import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorOAuth2Contract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { IN_VITEST } from "../../../env.ts";
import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../api-client.ts";
import { setLoop, withCleanup } from "../../utils.ts";
import { sanitizeTokenInput } from "./token-input.ts";

const internalReload$ = state(0);

export type CustomConnectorAuthMethodType = "api" | "oauth2";

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
 * List of org custom connectors (with per-caller `hasSecret` flag).
 * Cache-busted by `reloadCustomConnectors$`.
 */
export const customConnectors$ = computed(
  async (get): Promise<CustomConnectorResponse[]> => {
    get(internalReload$);
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorsContract);
    const result = await accept(client.list(), [200]);
    return result.body.connectors;
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
    body: CreateCustomConnectorBody,
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
    toast.success(
      i18n.t(
        ($) => {
          return $.connectors.custom.toasts.created;
        },
        { connector: result.body.displayName },
      ),
    );
    return result.body;
  },
);

export const updateCustomConnector$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly body: UpdateCustomConnectorBody;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorByIdContract);
    const result = await accept(
      client.update({
        params: { id: args.id },
        body: args.body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(bumpReload$);
    toast.success(`Updated "${result.body.displayName}"`);
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
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.deleted;
      }),
    );
  },
);

export const renameCustomConnector$ = command(
  async (
    { get, set },
    args: { id: string; displayName: string },
    signal: AbortSignal,
  ): Promise<CustomConnectorResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorByIdContract);
    const result = await accept(
      client.patch({
        params: { id: args.id },
        body: { displayName: args.displayName },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(bumpReload$);
    toast.success(
      i18n.t(
        ($) => {
          return $.connectors.custom.toasts.renamed;
        },
        { connector: result.body.displayName },
      ),
    );
    return result.body;
  },
);

export const setCustomConnectorSecret$ = command(
  async (
    { get, set },
    args: { id: string; value: string },
    _signal: AbortSignal,
  ): Promise<void> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorSecretContract);
    await accept(
      client.set({
        params: { id: args.id },
        body: { value: sanitizeTokenInput(args.value) },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );
    set(bumpReload$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.connected;
      }),
    );
  },
);

export const clearCustomConnectorSecret$ = command(
  async ({ get, set }, id: string, _signal: AbortSignal): Promise<void> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorSecretContract);
    await accept(
      client.delete({
        params: { id },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );
    set(bumpReload$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.disconnected;
      }),
    );
  },
);

export const connectCustomConnectorOAuth2$ = command(
  async ({ get, set }, id: string, signal: AbortSignal): Promise<void> => {
    const authWindow = window.open(
      "about:blank",
      "_blank",
      "width=600,height=700",
    );
    if (!authWindow) {
      throw new Error("Failed to open authorization window");
    }
    authWindow.opener = null;
    let navigated = false;
    await withCleanup(
      (async () => {
        const createClient = get(zeroClient$);
        const client = createClient(zeroCustomConnectorOAuth2Contract, {
          apiBase: "api",
        });
        const result = await accept(
          client.start({
            params: { id },
            body: {},
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
        authWindow.location.href = result.body.authorizationUrl;
        navigated = true;
      })(),
      () => {
        if (!navigated) {
          authWindow.close();
        }
      },
    );
    signal.throwIfAborted();
    await setLoop(
      () => {
        return authWindow.closed;
      },
      IN_VITEST ? 10 : 250,
      signal,
    );
    signal.throwIfAborted();
    set(bumpReload$);
  },
);

// ---------------------------------------------------------------------------
// Settings page dialog state — tracks which dialog is open.
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; connector: CustomConnectorResponse }
  | { kind: "rename"; connector: CustomConnectorResponse }
  | { kind: "connect"; connector: CustomConnectorResponse }
  | { kind: "delete"; connector: CustomConnectorResponse };

const internalDialog$ = state<DialogState>({ kind: "none" });
const internalEditConfirmation$ = state<{
  readonly connector: CustomConnectorResponse;
  readonly body: UpdateCustomConnectorBody;
} | null>(null);

export const customConnectorDialog$ = computed((get) => {
  return get(internalDialog$);
});
export const customConnectorEditConfirmation$ = computed((get) => {
  return get(internalEditConfirmation$);
});
export const openCustomConnectorCreateDialog$ = command(({ set }) => {
  set(internalEditConfirmation$, null);
  set(internalDialog$, { kind: "create" });
});
export const openCustomConnectorEditDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalCreateForm$, createFormFromConnector(connector));
    set(internalEditConfirmation$, null);
    set(internalDialog$, { kind: "edit", connector });
  },
);
export const openCustomConnectorEditConfirmationDialog$ = command(
  (
    { set },
    args: {
      readonly connector: CustomConnectorResponse;
      readonly body: UpdateCustomConnectorBody;
    },
  ) => {
    set(internalEditConfirmation$, args);
  },
);
export const closeCustomConnectorEditConfirmationDialog$ = command(
  ({ set }) => {
    set(internalEditConfirmation$, null);
  },
);
export const openCustomConnectorRenameDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "rename", connector });
  },
);
export const openCustomConnectorConnectDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalConnectForm$, {
      ...CONNECT_FORM_DEFAULTS,
      authMethod: connector.authMode === "oauth" ? "oauth2" : "api",
    });
    set(internalDialog$, { kind: "connect", connector });
  },
);
export const openCustomConnectorDeleteDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "delete", connector });
  },
);
export const closeCustomConnectorDialog$ = command(({ set }) => {
  set(internalEditConfirmation$, null);
  set(internalDialog$, { kind: "none" });
});

// ---------------------------------------------------------------------------
// Create form state
// ---------------------------------------------------------------------------

export interface CustomConnectorCreateForm {
  displayName: string;
  prefixesRaw: string;
  headerName: string;
  headerTemplate: string;
  authMethodTypes: readonly CustomConnectorAuthMethodType[];
  oauthAuthorizationUrl: string;
  oauthTokenUrl: string;
  oauthScopesRaw: string;
  oauthClientAuthentication: "client_secret_basic" | "client_secret_post";
  oauthPkceMethod: "none" | "S256";
  oauthResource: string;
  oauthAudience: string;
  oauthAccessType: string;
  oauthPrompt: string;
  oauthClientId: string;
  oauthClientSecret: string;
}

type CustomConnectorOAuthCreateForm = Pick<
  CustomConnectorCreateForm,
  | "oauthAuthorizationUrl"
  | "oauthTokenUrl"
  | "oauthScopesRaw"
  | "oauthClientAuthentication"
  | "oauthPkceMethod"
  | "oauthResource"
  | "oauthAudience"
  | "oauthAccessType"
  | "oauthPrompt"
  | "oauthClientId"
  | "oauthClientSecret"
>;

const OAUTH_CREATE_FORM_DEFAULTS = {
  oauthAuthorizationUrl: "",
  oauthTokenUrl: "",
  oauthScopesRaw: "",
  oauthClientAuthentication: "client_secret_post",
  oauthPkceMethod: "none",
  oauthResource: "",
  oauthAudience: "",
  oauthAccessType: "",
  oauthPrompt: "",
  oauthClientId: "",
  oauthClientSecret: "",
} as const satisfies CustomConnectorOAuthCreateForm;

const CREATE_FORM_DEFAULTS = {
  displayName: "",
  prefixesRaw: "",
  headerName: "Authorization",
  headerTemplate: "Bearer {{secret}}",
  authMethodTypes: ["api"],
  ...OAUTH_CREATE_FORM_DEFAULTS,
} as const satisfies CustomConnectorCreateForm;

function oauthCreateFormFromConnector(
  connector: CustomConnectorResponse,
): CustomConnectorOAuthCreateForm {
  const oauthConfig = connector.oauthConfig;
  if (!oauthConfig) {
    return { ...OAUTH_CREATE_FORM_DEFAULTS };
  }
  const authorizationParams = oauthConfig.authorizationParams;
  return {
    oauthAuthorizationUrl: oauthConfig.authorizationUrl,
    oauthTokenUrl: oauthConfig.tokenUrl,
    oauthScopesRaw: oauthConfig.scopes.join("\n"),
    oauthClientAuthentication: oauthConfig.tokenEndpointAuthMethod,
    oauthPkceMethod: oauthConfig.pkceMethod,
    oauthResource: authorizationParams.resource ?? "",
    oauthAudience: authorizationParams.audience ?? "",
    oauthAccessType: authorizationParams.access_type ?? "",
    oauthPrompt: authorizationParams.prompt ?? "",
    oauthClientId: oauthConfig.clientId,
    oauthClientSecret: "",
  };
}

function createFormFromConnector(
  connector: CustomConnectorResponse,
): CustomConnectorCreateForm {
  return {
    displayName: connector.displayName,
    prefixesRaw: connector.prefixTemplates.join("\n"),
    headerName: connector.headerName,
    headerTemplate: connector.headerTemplate,
    authMethodTypes: [connector.authMode === "oauth" ? "oauth2" : "api"],
    ...oauthCreateFormFromConnector(connector),
  };
}

const internalCreateForm$ =
  state<CustomConnectorCreateForm>(CREATE_FORM_DEFAULTS);
export const customConnectorCreateForm$ = computed((get) => {
  return get(internalCreateForm$);
});
export const setCustomConnectorCreateField$ = command(
  (
    { get, set },
    field: Exclude<keyof CustomConnectorCreateForm, "authMethodTypes">,
    value: string,
  ) => {
    const prev = get(internalCreateForm$);
    set(internalCreateForm$, { ...prev, [field]: value });
  },
);
export const addCustomConnectorAuthMethod$ = command(
  ({ get, set }, type: CustomConnectorAuthMethodType) => {
    const form = get(internalCreateForm$);
    if (form.authMethodTypes.includes(type)) {
      return;
    }
    set(internalCreateForm$, {
      ...form,
      authMethodTypes: [type],
    });
  },
);
export const removeCustomConnectorAuthMethod$ = command(
  ({ get, set }, type: CustomConnectorAuthMethodType) => {
    const form = get(internalCreateForm$);
    set(internalCreateForm$, {
      ...form,
      authMethodTypes: form.authMethodTypes.filter((value) => {
        return value !== type;
      }),
    });
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

interface CustomConnectorConnectForm {
  readonly authMethod: CustomConnectorAuthMethodType | null;
  readonly apiSecret: string;
}

const CONNECT_FORM_DEFAULTS = {
  authMethod: null,
  apiSecret: "",
} as const satisfies CustomConnectorConnectForm;

const internalConnectForm$ = state<CustomConnectorConnectForm>(
  CONNECT_FORM_DEFAULTS,
);
export const customConnectorConnectForm$ = computed((get) => {
  return get(internalConnectForm$);
});
export const setCustomConnectorConnectField$ = command(
  (
    { get, set },
    field: keyof CustomConnectorConnectForm,
    value: string | null,
  ) => {
    const form = get(internalConnectForm$);
    set(internalConnectForm$, { ...form, [field]: value });
  },
);
export const resetCustomConnectorConnectInput$ = command(({ set }) => {
  set(internalConnectForm$, CONNECT_FORM_DEFAULTS);
});
