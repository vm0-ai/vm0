import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { AgentPhoneConnectPage } from "../../views/okou-page/agentphone-connect-page.tsx";
import { parseAgentPhoneConnectParams } from "./agentphone-connect-params.ts";

export const setupAgentPhoneConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const parsed = parseAgentPhoneConnectParams(get(searchParams$));
    capturePlausibleEvent("agentphone_connect_visit", {
      props: { method: parsed.ok ? "connect_signature" : "invalid" },
    });

    set(updatePage$, createElement(AgentPhoneConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
