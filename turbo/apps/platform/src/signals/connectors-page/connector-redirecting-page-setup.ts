import {
  connectorRefSchema,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  publicConnectorCatalogIconSchema,
  type PublicConnectorCatalogIcon,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { command } from "ccstate";
import { createElement } from "react";
import { ZeroConnectorRedirectingPage } from "../../views/zero-page/zero-connector-redirecting-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import {
  resetConnectorRedirectingMobileWarning$,
  showConnectorRedirectingMobileWarningAfterDelay$,
  type ConnectorRedirectingStatus,
} from "./connector-redirecting.ts";

function connectorTypeFromPath(value: string | undefined): ConnectorRef | null {
  const parsed = connectorRefSchema.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : null;
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

export const setupConnectorRedirectingPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const connectorType = connectorTypeFromPath(
      typeof params?.type === "string" ? params.type : undefined,
    );
    const searchParams = get(searchParams$);
    const connectorLabel =
      searchParams.get("label")?.trim() || connectorType || "connector";
    const status: ConnectorRedirectingStatus =
      searchParams.get("status") === "error" ? "error" : "redirecting";
    const connectorIcon = connectorIconFromSearchParams(searchParams);

    set(resetConnectorRedirectingMobileWarning$);
    set(
      updatePage$,
      createElement(ZeroConnectorRedirectingPage, {
        connectorLabel,
        connectorIcon,
        status,
      }),
    );
    set(updateDocumentTitle$, `Connect ${connectorLabel}`);
    await set(hideAppSkeleton$, signal);
    if (status === "redirecting") {
      await set(showConnectorRedirectingMobileWarningAfterDelay$, signal);
    }
  },
);
