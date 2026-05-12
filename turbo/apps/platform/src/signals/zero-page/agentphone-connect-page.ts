import { command } from "ccstate";
import { createElement } from "react";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { ZeroAgentPhoneConnectPage } from "../../views/zero-page/zero-agentphone-connect-page.tsx";
import { parseAgentPhoneConnectParams } from "./agentphone-connect-params.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupAgentPhoneConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    const parsed = parseAgentPhoneConnectParams(get(searchParams$));
    capturePlausibleEvent("agentphone_connect_visit", {
      props: { method: parsed.ok ? "connect_signature" : "invalid" },
    });

    set(updatePage$, createElement(ZeroAgentPhoneConnectPage));
    set(updateDocumentTitle$, "Connect Messages");
    await set(hideAppSkeleton$, signal);
  },
);
