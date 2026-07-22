import {
  connectorsTypeCallbackContract,
  type ConnectorOauthCallbackResult,
} from "@vm0/api-contracts/contracts/connectors-type-callback";
import {
  connectorRefSchema,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import { command } from "ccstate";
import { createElement } from "react";
import { accept } from "../../lib/accept.ts";
import { ZeroConnectorCallbackPage } from "../../views/zero-page/zero-connector-callback-page.tsx";
import { zeroClient$ } from "../api-client.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$, replacePathSilently$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

type ConnectorCallbackPageResult =
  | { readonly status: "loading" }
  | ConnectorOauthCallbackResult;

function connectorRefFromPath(value: string | undefined): ConnectorRef | null {
  const parsed = connectorRefSchema.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : null;
}

function connectorLabel(connectorRef: ConnectorRef | null): string {
  if (!connectorRef) {
    return "Connector";
  }
  return connectorRef === "github" ? "GitHub" : connectorRef.toUpperCase();
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
  label: string,
  result: ConnectorCallbackPageResult,
): React.JSX.Element {
  return createElement(ZeroConnectorCallbackPage, {
    connectorLabel: label,
    status: result.status,
    username: result.status === "success" ? result.username : null,
    errorMessage: result.status === "error" ? result.message : null,
  });
}

const completeConnectorCallback$ = command(
  async (
    { get },
    connectorRef: ConnectorRef,
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ConnectorOauthCallbackResult> => {
    const client = get(zeroClient$)(connectorsTypeCallbackContract, {
      apiBase: "api",
    });
    const response = await accept(
      client.callback({
        params: { type: connectorRef },
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
    const connectorRef = connectorRefFromPath(
      typeof params?.type === "string" ? params.type : undefined,
    );
    const label = connectorLabel(connectorRef);
    const searchParams = get(searchParams$);
    const pathResult = resultFromPath(
      typeof params?.status === "string" ? params.status : undefined,
      searchParams,
    );

    if (pathResult) {
      set(updatePage$, callbackPageElement(label, pathResult));
      set(updateDocumentTitle$, `Connect ${label}`);
      await set(hideAppSkeleton$, signal);
      return;
    }

    if (!connectorRef) {
      set(
        updatePage$,
        callbackPageElement(label, {
          status: "error",
          message: "Invalid connector callback URL.",
        }),
      );
      set(updateDocumentTitle$, `Connect ${label}`);
      await set(hideAppSkeleton$, signal);
      return;
    }

    set(updatePage$, callbackPageElement(label, { status: "loading" }));
    set(updateDocumentTitle$, `Connect ${label}`);
    await set(hideAppSkeleton$, signal);

    const result = await set(
      completeConnectorCallback$,
      connectorRef,
      Object.fromEntries(searchParams),
      signal,
    );
    set(updatePage$, callbackPageElement(label, result));

    const resultSearchParams = new URLSearchParams();
    if (result.status === "success" && result.username) {
      resultSearchParams.set("username", result.username);
    }
    if (result.status === "error") {
      resultSearchParams.set("message", result.message);
    }
    set(
      replacePathSilently$,
      ROUTES.connectorCallbackResult,
      { type: connectorRef, status: result.status },
      resultSearchParams,
    );
  },
);
