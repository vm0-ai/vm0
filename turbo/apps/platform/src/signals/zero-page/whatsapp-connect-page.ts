import { command } from "ccstate";
import { createElement } from "react";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { ZeroWhatsAppConnectPage } from "../../views/zero-page/zero-whatsapp-connect-page.tsx";
import { parseWhatsAppConnectParams } from "./whatsapp-connect-params.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupWhatsAppConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    const parsed = parseWhatsAppConnectParams(get(searchParams$));
    capturePlausibleEvent("whatsapp_connect_visit", {
      props: { method: parsed.ok ? "connect_signature" : "invalid" },
    });

    set(updatePage$, createElement(ZeroWhatsAppConnectPage));
    set(updateDocumentTitle$, "Connect WhatsApp");
    await set(hideAppSkeleton$, signal);
  },
);
