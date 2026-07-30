import {
  connectorsSlugCallbackContract,
  type ConnectorOauthCallbackResult,
} from "@vm0/api-contracts/contracts/connectors-slug-callback";
import { zeroCustomConnectorOAuth2Contract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  publicConnectorCatalogIconSchema,
  type PublicConnectorCatalogIcon,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY } from "@vm0/connectors/app-oauth-callback";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import { command } from "ccstate";
import { createElement } from "react";
import { accept } from "../../lib/accept.ts";
import { ZeroConnectorCallbackPage } from "../../views/zero-page/zero-connector-callback-page.tsx";
import { zeroClient$ } from "../api-client.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$, replacePathSilently$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { jsonParseOr } from "../utils.ts";

type ConnectorCallbackPageResult =
  | { readonly status: "loading" }
  | ConnectorOauthCallbackResult;
type ConnectorCallbackType = ConnectorSlug | "custom";

const {
  get$: connectorAppOauthCallbackMetadataRaw$,
  clear$: clearConnectorAppOauthCallbackMetadata$,
} = localStorageSignals(CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY);

function connectorTypeFromPath(
  value: string | undefined,
): ConnectorCallbackType | null {
  const normalized = value?.toLowerCase();
  if (normalized === "custom") {
    return normalized;
  }
  const parsed = connectorSlugSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function connectorLabel(connectorType: ConnectorCallbackType | null): string {
  if (!connectorType) {
    return "Connector";
  }
  if (connectorType === "custom") {
    return "Custom connector";
  }
  return connectorType === "github" ? "GitHub" : connectorType.toUpperCase();
}

function connectorIconFromSearchParams(
  searchParams: URLSearchParams,
): PublicConnectorCatalogIcon | undefined {
  const url = searchParams.get("iconUrl");
  const invertInDarkMode = searchParams.get("iconInvertInDarkMode");
  if (!url || (invertInDarkMode !== "true" && invertInDarkMode !== "false")) {
    return undefined;
  }
  const scale = searchParams.get("iconScale");
  const parsed = publicConnectorCatalogIconSchema.safeParse({
    url,
    invertInDarkMode: invertInDarkMode === "true",
    ...(scale === null ? {} : { scale: Number(scale) }),
  });
  return parsed.success ? parsed.data : undefined;
}

function addConnectorIconSearchParams(
  searchParams: URLSearchParams,
  icon: PublicConnectorCatalogIcon | undefined,
): void {
  if (!icon) {
    return;
  }
  searchParams.set("iconUrl", icon.url);
  searchParams.set("iconInvertInDarkMode", String(icon.invertInDarkMode));
  if (icon.scale !== undefined) {
    searchParams.set("iconScale", String(icon.scale));
  }
}

function connectorCallbackMetadataFromStorage(
  raw: string | null,
  connectorSlug: ConnectorSlug | null,
): {
  readonly connectorSlug: ConnectorSlug;
  readonly icon: PublicConnectorCatalogIcon;
} | null {
  if (!raw || !connectorSlug) {
    return null;
  }
  const value = jsonParseOr<unknown>(raw, null);
  if (
    typeof value !== "object" ||
    value === null ||
    // TODO(#23619): Rename with the persisted app OAuth callback metadata.
    !("connectorRef" in value) ||
    !("icon" in value)
  ) {
    return null;
  }
  const parsedConnectorSlug = connectorSlugSchema.safeParse(value.connectorRef);
  const parsedIcon = publicConnectorCatalogIconSchema.safeParse(value.icon);
  if (
    !parsedConnectorSlug.success ||
    parsedConnectorSlug.data !== connectorSlug ||
    !parsedIcon.success
  ) {
    return null;
  }
  return {
    connectorSlug: parsedConnectorSlug.data,
    icon: parsedIcon.data,
  };
}

function resultFromPath(
  status: string | undefined,
  searchParams: URLSearchParams,
): ConnectorOauthCallbackResult | null {
  if (status === "success") {
    return {
      status,
      username: searchParams.get("username"),
    };
  }
  if (status === "error") {
    return {
      status,
      message:
        searchParams.get("message") || "An error occurred during connection.",
    };
  }
  return null;
}

function callbackPageElement(
  connectorIcon: PublicConnectorCatalogIcon | undefined,
  label: string,
  result: ConnectorCallbackPageResult,
): React.JSX.Element {
  return createElement(ZeroConnectorCallbackPage, {
    connectorIcon,
    connectorLabel: label,
    status: result.status,
    username: result.status === "success" ? result.username : null,
    errorMessage: result.status === "error" ? result.message : null,
  });
}

const completeConnectorCallback$ = command(
  async (
    { get },
    connectorSlug: ConnectorSlug,
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ConnectorOauthCallbackResult> => {
    const client = get(zeroClient$)(connectorsSlugCallbackContract, {
      apiBase: "api",
    });
    const response = await accept(
      client.callback({
        params: { connectorSlug },
        query: { ...query, responseMode: "json" },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return response.body;
  },
);

const completeCustomConnectorCallback$ = command(
  async (
    { get },
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ConnectorOauthCallbackResult> => {
    const client = get(zeroClient$)(zeroCustomConnectorOAuth2Contract, {
      apiBase: "api",
    });
    const response = await accept(
      client.callback({
        query: { ...query, responseMode: "json" },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return response.body;
  },
);

export const setupConnectorCallbackPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const connectorType = connectorTypeFromPath(
      typeof params?.type === "string" ? params.type : undefined,
    );
    const connectorSlug = connectorType === "custom" ? null : connectorType;
    const label = connectorLabel(connectorType);
    const searchParams = get(searchParams$);
    const storedMetadata = connectorCallbackMetadataFromStorage(
      get(connectorAppOauthCallbackMetadataRaw$),
      connectorSlug,
    );
    const connectorIcon =
      connectorIconFromSearchParams(searchParams) ?? storedMetadata?.icon;
    const pathResult = resultFromPath(
      typeof params?.status === "string" ? params.status : undefined,
      searchParams,
    );

    if (pathResult) {
      set(updatePage$, callbackPageElement(connectorIcon, label, pathResult));
      set(updateDocumentTitle$, `Connect ${label}`);
      await set(hideAppSkeleton$, signal);
      return;
    }

    if (!connectorType) {
      set(
        updatePage$,
        callbackPageElement(connectorIcon, label, {
          status: "error",
          message: "Invalid connector callback URL.",
        }),
      );
      set(updateDocumentTitle$, `Connect ${label}`);
      await set(hideAppSkeleton$, signal);
      return;
    }

    set(
      updatePage$,
      callbackPageElement(connectorIcon, label, { status: "loading" }),
    );
    set(updateDocumentTitle$, `Connect ${label}`);
    await set(hideAppSkeleton$, signal);

    const query = Object.fromEntries(searchParams);
    const result =
      connectorType === "custom"
        ? await set(completeCustomConnectorCallback$, query, signal)
        : await set(completeConnectorCallback$, connectorType, query, signal);
    set(updatePage$, callbackPageElement(connectorIcon, label, result));

    const resultSearchParams = new URLSearchParams();
    if (result.status === "success" && result.username) {
      resultSearchParams.set("username", result.username);
    }
    if (result.status === "error") {
      resultSearchParams.set("message", result.message);
    }
    addConnectorIconSearchParams(resultSearchParams, connectorIcon);
    set(
      replacePathSilently$,
      ROUTES.connectorCallbackResult,
      { type: connectorType, status: result.status },
      resultSearchParams,
    );
    if (storedMetadata) {
      set(clearConnectorAppOauthCallbackMetadata$);
    }
  },
);
