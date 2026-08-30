import { command } from "ccstate";
import { Landmark } from "lucide-react";
import { createElement } from "react";

import { i18n } from "../i18n/index.ts";
import { ConnectorCallbackPage } from "../views/okou-page/connector-callback-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";
import { pathParams$, replacePathSilently$, searchParams$ } from "./route.ts";
import { ROUTES } from "./route-paths.ts";

type BankingConnectReturnStatus = "success" | "error";

export const setupBankingConnectReturnPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const pathStatus = get(pathParams$)?.bankingConnectStatus;
    const searchParams = get(searchParams$);
    const status: BankingConnectReturnStatus =
      pathStatus === "success" || pathStatus === "error"
        ? pathStatus
        : searchParams.get("reason") === "complete" &&
            searchParams.get("code") === "200"
          ? "success"
          : "error";
    const label = i18n.t(($) => {
      return $.chat.banking.accountFallback;
    });

    set(
      updatePage$,
      createElement(ConnectorCallbackPage, {
        connectorIcon: undefined,
        iconContent: createElement(Landmark, {
          size: 20,
          className: "text-foreground",
          role: "img",
          "aria-label": label,
        }),
        connectorLabel: label,
        status,
        username: null,
        errorMessage:
          status === "error"
            ? i18n.t(($) => {
                return $.connectors.callback.errorFallback;
              })
            : null,
      }),
    );
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.connectors.callback.documentTitle;
        },
        { connector: label },
      ),
    );
    await set(hideAppSkeleton$, signal);

    if (pathStatus !== "success" && pathStatus !== "error") {
      set(
        replacePathSilently$,
        ROUTES.bankingConnectReturnResult,
        { bankingConnectStatus: status },
        new URLSearchParams(),
      );
    }
  },
);
