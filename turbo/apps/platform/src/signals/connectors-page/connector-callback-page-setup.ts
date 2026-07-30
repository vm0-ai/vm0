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
import { i18n } from "../../i18n/index.ts";

type ConnectorCallbackPageResult =
  | { readonly status: "loading" }
  | ConnectorOauthCallbackResult;
type ConnectorCallbackSlug = ConnectorSlug | "custom";

const {
  get$: connectorAppOauthCallbackMetadataRaw$,
  clear$: clearConnectorAppOauthCallbackMetadata$,
} = localStorageSignals(CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY);

function connectorSlugFromPath(
  value: string | undefined,
): ConnectorCallbackSlug | null {
  const normalized = value?.toLowerCase();
  if (normalized === "custom") {
    return normalized;
  }
  const parsed = connectorSlugSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function connectorLabel(connectorSlug: ConnectorCallbackSlug | null): string {
  if (!connectorSlug) {
    return i18n.t(($) => {
      return $.connectors.callback.genericLabel;
    });
  }
  if (connectorSlug === "custom") {
    return i18n.t(($) => {
      return $.connectors.callback.customConnectorLabel;
    });
  }
  return connectorSlug === "github"
    ? i18n.t(($) => {
        return $.connectors.callback.githubLabel;
      })
    : connectorSlug.toUpperCase();
}

function connectorCallbackDocumentTitle(label: string): string {
  return i18n.t(
    ($) => {
      return $.connectors.callback.documentTitle;
    },
    { connector: label },
  );
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
  if (typeof value !== "object" || value === null || !("icon" in value)) {
    return null;
  }
  // TODO(#23823): Remove the legacy callback metadata fallback.
  const storedConnectorSlug =
    "connectorSlug" in value
      ? value.connectorSlug
      : "connectorRef" in value
        ? value.connectorRef
        : undefined;
  const parsedConnectorSlug =
    connectorSlugSchema.safeParse(storedConnectorSlug);
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
        searchParams.get("message") ||
        i18n.t(($) => {
          return $.connectors.callback.errorFallback;
        }),
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
    const callbackConnectorSlug = connectorSlugFromPath(
      typeof params?.connectorSlug === "string"
        ? params.connectorSlug
        : undefined,
    );
    const connectorSlug =
      callbackConnectorSlug === "custom" ? null : callbackConnectorSlug;
    const label = connectorLabel(callbackConnectorSlug);
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
      set(updateDocumentTitle$, connectorCallbackDocumentTitle(label));
      await set(hideAppSkeleton$, signal);
      return;
    }

    if (!callbackConnectorSlug) {
      set(
        updatePage$,
        callbackPageElement(connectorIcon, label, {
          status: "error",
          message: i18n.t(($) => {
            return $.connectors.callback.invalidUrl;
          }),
        }),
      );
      set(updateDocumentTitle$, connectorCallbackDocumentTitle(label));
      await set(hideAppSkeleton$, signal);
      return;
    }

    set(
      updatePage$,
      callbackPageElement(connectorIcon, label, { status: "loading" }),
    );
    set(updateDocumentTitle$, connectorCallbackDocumentTitle(label));
    await set(hideAppSkeleton$, signal);

    const query = Object.fromEntries(searchParams);
    const result =
      callbackConnectorSlug === "custom"
        ? await set(completeCustomConnectorCallback$, query, signal)
        : await set(
            completeConnectorCallback$,
            callbackConnectorSlug,
            query,
            signal,
          );
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
      { connectorSlug: callbackConnectorSlug, status: result.status },
      resultSearchParams,
    );
    if (storedMetadata) {
      set(clearConnectorAppOauthCallbackMetadata$);
    }
  },
);
