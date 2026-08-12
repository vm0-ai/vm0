import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorConnectionContract,
  zeroCustomConnectorOAuth2Contract,
  zeroCustomConnectorValuesContract,
  zeroCustomConnectorsContract,
  customConnectorListResponseSchema,
  customConnectorResponseSchema,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type CustomConnectorValueInput,
  type UpdateCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  zeroAgentCustomConnectorsContract,
  type AgentCustomConnectorGrants,
} from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { IN_VITEST } from "../../../env.ts";
import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { setAblyLoop$ } from "../../realtime.ts";
import { setLoop, withCleanup } from "../../utils.ts";

const internalReload$ = state(0);
const internalAuthorizedAgentsReload$ = state(0);

export type CustomConnectorAuthMethodType = "api" | "oauth2";

export const customConnectorAuthorizationReloadVersion$ = computed((get) => {
  return get(internalAuthorizedAgentsReload$);
});

// ---------------------------------------------------------------------------
// Active tab on the Connectors settings page
// ---------------------------------------------------------------------------

type ConnectorsPageTab = "builtin" | "custom";

function normalizeConnectorsPageTab(value: string | null): ConnectorsPageTab {
  return value === "custom" ? "custom" : "builtin";
}

export const connectorsPageTab$ = computed((get) => {
  return normalizeConnectorsPageTab(get(searchParams$).get("tab"));
});
export const setConnectorsPageTab$ = command(({ get, set }, value: string) => {
  const tab = normalizeConnectorsPageTab(value);
  const next = new URLSearchParams(get(searchParams$));
  if (tab === "builtin") {
    next.delete("tab");
  } else {
    next.set("tab", tab);
  }
  set(updateSearchParams$, next);
});

/**
 * List of org custom connectors with canonical connection status.
 * Cache-busted by `reloadCustomConnectors$`.
 */
export const customConnectors$ = computed(
  async (get): Promise<CustomConnectorResponse[]> => {
    get(internalReload$);
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorsContract);
    const result = await accept(client.list(), [200]);
    return customConnectorListResponseSchema.parse(result.body).connectors;
  },
);

export interface CustomConnectorAgentAuthorization {
  readonly agent: TeamComposeItem;
  readonly access: AgentCustomConnectorGrants;
}

export const customConnectorAgentAuthorizations$ = computed(
  async (get): Promise<readonly CustomConnectorAgentAuthorization[]> => {
    get(customConnectorAuthorizationReloadVersion$);
    const connectors = await get(customConnectors$);
    if (connectors.length === 0) {
      return [];
    }

    const allAgents = await get(agents$);
    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    const rows = await Promise.all(
      allAgents.map(async (agent) => {
        const result = await accept(
          client.get({ params: { id: agent.id } }),
          [200, 404],
        );
        return result.status === 404 ? null : { agent, access: result.body };
      }),
    );
    return rows.filter((row): row is CustomConnectorAgentAuthorization => {
      return row !== null;
    });
  },
);

export const customConnectorAuthorizedAgentsById$ = computed(
  async (get): Promise<ReadonlyMap<string, readonly TeamComposeItem[]>> => {
    const rows = await get(customConnectorAgentAuthorizations$);
    const agentsByConnectorId = new Map<string, TeamComposeItem[]>();
    for (const row of rows) {
      for (const grant of row.access.grants) {
        const authorizedAgents =
          agentsByConnectorId.get(grant.customConnectorId) ?? [];
        authorizedAgents.push(row.agent);
        agentsByConnectorId.set(grant.customConnectorId, authorizedAgents);
      }
    }
    return agentsByConnectorId;
  },
);

export const reloadCustomConnectorAuthorizedAgents$ = command(({ set }) => {
  set(internalAuthorizedAgentsReload$, (value) => {
    return value + 1;
  });
});

export const setCustomConnectorAgentAuthorization$ = command(
  async (
    { get, set },
    args: {
      readonly agentId: string;
      readonly connectorId: string;
      readonly permissionBundleRef: string | null;
      readonly authorized: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.authorized && args.permissionBundleRef) {
      return false;
    }
    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    await withCleanup(
      accept(
        client.update({
          params: { id: args.agentId },
          body: {
            grants: [
              {
                customConnectorId: args.connectorId,
                permissionNames: [],
              },
            ],
            operation: args.authorized ? "add" : "remove",
          },
          fetchOptions: { signal },
        }),
        [200],
      ),
      () => {
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
    signal.throwIfAborted();
    return true;
  },
);

const bumpReload$ = command(({ set }) => {
  set(internalReload$, (v) => {
    return v + 1;
  });
});

const reloadCustomConnectorsFromRealtime$ = command(({ set }) => {
  set(bumpReload$);
  return false;
});

export const subscribeCustomConnectorListChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyLoop$,
      {
        topic: "customConnectorListChanged",
        loopCommand$: reloadCustomConnectorsFromRealtime$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

type CustomConnectorAuthorizationTarget =
  | { readonly kind: "visible-agents" }
  | { readonly kind: "agent"; readonly agentId: string };

const authorizeCustomConnectorForTarget$ = command(
  async (
    { get, set },
    args: {
      readonly connectorId: string;
      readonly target: CustomConnectorAuthorizationTarget;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const agentIds =
      args.target.kind === "agent"
        ? [args.target.agentId]
        : (await get(agents$)).map((agent) => {
            return agent.id;
          });
    signal.throwIfAborted();
    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    await withCleanup(
      Promise.all(
        agentIds.map(async (agentId) => {
          await accept(
            client.update({
              params: { id: agentId },
              body: {
                grants: [
                  {
                    customConnectorId: args.connectorId,
                    permissionNames: [],
                  },
                ],
                operation: "add",
              },
              fetchOptions: { signal },
            }),
            args.target.kind === "agent" ? [200] : [200, 404],
          );
        }),
      ),
      () => {
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
    signal.throwIfAborted();
  },
);

const isCustomConnectorAuthorizedForTarget$ = command(
  async (
    { get },
    args: {
      readonly connectorId: string;
      readonly target: CustomConnectorAuthorizationTarget;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.target.kind === "visible-agents") {
      return false;
    }
    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    const result = await accept(
      client.get({
        params: { id: args.target.agentId },
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    signal.throwIfAborted();
    return (
      result.status === 200 &&
      result.body.grants.some((grant) => {
        return grant.customConnectorId === args.connectorId;
      })
    );
  },
);

interface CustomConnectorConnectionResult {
  readonly connected: boolean;
  readonly targetAuthorized: boolean;
}

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
    const connector = customConnectorResponseSchema.parse(result.body);
    set(bumpReload$);
    toast.success(
      i18n.t(
        ($) => {
          return $.connectors.custom.toasts.created;
        },
        { connector: connector.displayName },
      ),
    );
    return connector;
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
    const connector = customConnectorResponseSchema.parse(result.body);
    set(bumpReload$);
    toast.success(
      i18n.t(
        ($) => {
          return $.connectors.custom.toasts.updated;
        },
        { connector: connector.displayName },
      ),
    );
    return connector;
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

const setCustomConnectorValuesForTarget$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
      readonly authorizationTarget: CustomConnectorAuthorizationTarget;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorValuesContract);
    const result = await accept(
      client.set({
        params: { id: args.id },
        body: { values: [...args.values] },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const connector = customConnectorResponseSchema.parse(result.body);
    set(bumpReload$);
    if (!connector.connected) {
      return { connected: false, targetAuthorized: false };
    }
    let targetAuthorized: boolean;
    if (connector.permissionBundleRef) {
      targetAuthorized = await set(
        isCustomConnectorAuthorizedForTarget$,
        { connectorId: connector.id, target: args.authorizationTarget },
        signal,
      );
    } else {
      await set(
        authorizeCustomConnectorForTarget$,
        {
          connectorId: connector.id,
          target: args.authorizationTarget,
        },
        signal,
      );
      targetAuthorized = true;
    }
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.connected;
      }),
    );
    return { connected: true, targetAuthorized };
  },
);

export const setCustomConnectorValues$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      setCustomConnectorValuesForTarget$,
      {
        ...args,
        authorizationTarget: { kind: "visible-agents" },
      },
      signal,
    );
  },
);

export const setCustomConnectorValuesForAgent$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly values: readonly CustomConnectorValueInput[];
      readonly agentId: string;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      setCustomConnectorValuesForTarget$,
      {
        id: args.id,
        values: args.values,
        authorizationTarget: { kind: "agent", agentId: args.agentId },
      },
      signal,
    );
  },
);

export const disconnectCustomConnector$ = command(
  async ({ get, set }, id: string, signal: AbortSignal): Promise<void> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroCustomConnectorConnectionContract);
    await accept(
      client.disconnect({
        params: { id },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(bumpReload$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.custom.toasts.disconnected;
      }),
    );
  },
);

const connectCustomConnectorOAuth2ForTarget$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly authorizationTarget: CustomConnectorAuthorizationTarget;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
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
            params: { id: args.id },
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
    const connectors = await get(customConnectors$);
    signal.throwIfAborted();
    const connector = connectors.find((candidate) => {
      return candidate.id === args.id;
    });
    let targetAuthorized = false;
    if (connector?.connected) {
      if (!connector.permissionBundleRef) {
        await set(
          authorizeCustomConnectorForTarget$,
          {
            connectorId: args.id,
            target: args.authorizationTarget,
          },
          signal,
        );
        targetAuthorized = true;
      } else {
        targetAuthorized = await set(
          isCustomConnectorAuthorizedForTarget$,
          { connectorId: connector.id, target: args.authorizationTarget },
          signal,
        );
      }
    }
    return {
      connected: connector?.connected ?? false,
      targetAuthorized,
    };
  },
);

export const connectCustomConnectorOAuth2$ = command(
  async (
    { set },
    id: string,
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      connectCustomConnectorOAuth2ForTarget$,
      {
        id,
        authorizationTarget: { kind: "visible-agents" },
      },
      signal,
    );
  },
);

export const connectCustomConnectorOAuth2ForAgent$ = command(
  async (
    { set },
    args: { readonly id: string; readonly agentId: string },
    signal: AbortSignal,
  ): Promise<CustomConnectorConnectionResult> => {
    return await set(
      connectCustomConnectorOAuth2ForTarget$,
      {
        id: args.id,
        authorizationTarget: { kind: "agent", agentId: args.agentId },
      },
      signal,
    );
  },
);

// ---------------------------------------------------------------------------
// Settings page dialog state — tracks which dialog is open.
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; connector: CustomConnectorResponse }
  | { kind: "connect"; connector: CustomConnectorResponse }
  | { kind: "access"; connector: CustomConnectorResponse }
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
export const openCustomConnectorConnectDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalConnectForm$, CONNECT_FORM_DEFAULTS);
    set(internalDialog$, { kind: "connect", connector });
  },
);
export const openCustomConnectorAccessDialog$ = command(
  ({ set }, connector: CustomConnectorResponse) => {
    set(internalDialog$, { kind: "access", connector });
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
  kind: CustomConnectorResponse["kind"];
  displayName: string;
  prefixesRaw: string;
  mcpEndpoint: string;
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
  kind: "http",
  displayName: "",
  prefixesRaw: "",
  mcpEndpoint: "",
  headerName: "Authorization",
  headerTemplate: "Bearer {{secret}}",
  authMethodTypes: [],
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
  const firstHeader = connector.headerInjections[0];
  return {
    kind: connector.kind,
    displayName: connector.displayName,
    prefixesRaw:
      connector.kind === "http" ? connector.prefixTemplates.join("\n") : "",
    mcpEndpoint: connector.kind === "mcp" ? connector.endpoint : "",
    headerName: firstHeader?.name ?? CREATE_FORM_DEFAULTS.headerName,
    headerTemplate:
      firstHeader?.valueTemplate.replaceAll(
        "{{secrets.secret}}",
        "{{secret}}",
      ) ?? CREATE_FORM_DEFAULTS.headerTemplate,
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
    field: Exclude<keyof CustomConnectorCreateForm, "authMethodTypes" | "kind">,
    value: string,
  ) => {
    const prev = get(internalCreateForm$);
    set(internalCreateForm$, { ...prev, [field]: value });
  },
);
export const setCustomConnectorCreateKind$ = command(
  ({ get, set }, kind: CustomConnectorResponse["kind"]) => {
    const form = get(internalCreateForm$);
    set(internalCreateForm$, { ...form, kind });
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
// Connect form state
// ---------------------------------------------------------------------------

interface CustomConnectorConnectForm {
  readonly values: Readonly<Record<string, string>>;
}

const CONNECT_FORM_DEFAULTS = {
  values: {},
} as const satisfies CustomConnectorConnectForm;

const internalConnectForm$ = state<CustomConnectorConnectForm>(
  CONNECT_FORM_DEFAULTS,
);
export const customConnectorConnectForm$ = computed((get) => {
  return get(internalConnectForm$);
});
export const setCustomConnectorConnectField$ = command(
  ({ get, set }, args: { readonly key: string; readonly value: string }) => {
    const form = get(internalConnectForm$);
    set(internalConnectForm$, {
      values: { ...form.values, [args.key]: args.value },
    });
  },
);
export const resetCustomConnectorConnectInput$ = command(({ set }) => {
  set(internalConnectForm$, CONNECT_FORM_DEFAULTS);
});
