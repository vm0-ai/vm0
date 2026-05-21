import { command } from "ccstate";
import { zeroIntegrationsWhatsAppContract } from "@vm0/api-contracts/contracts/zero-integrations-whatsapp";
import { accept } from "../../lib/accept.ts";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { zeroClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { parseWhatsAppConnectParams } from "./whatsapp-connect-params.ts";

export const connectWhatsAppAccount$ = command(
  async ({ get }, signal: AbortSignal) => {
    const parsed = parseWhatsAppConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const client = get(zeroClient$)(zeroIntegrationsWhatsAppContract);
    const result = await accept(
      client.connectWhatsApp({
        headers: {},
        fetchOptions: { signal },
        body: parsed.params,
      }),
      [200],
    );
    signal.throwIfAborted();

    capturePlausibleEvent("whatsapp_connect", {
      props: { channel: "whatsapp" },
    });

    return result.body;
  },
);
