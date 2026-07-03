import { command } from "ccstate";
import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { accept } from "../../lib/accept.ts";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { zeroClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { parseAgentPhoneConnectParams } from "./agentphone-connect-params.ts";

export const connectAgentPhoneAccount$ = command(
  async ({ get }, signal: AbortSignal) => {
    const parsed = parseAgentPhoneConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const client = get(zeroClient$)(zeroIntegrationsAgentPhoneContract);
    const result = await accept(
      client.connectAgentPhone({
        headers: {},
        fetchOptions: { signal },
        body: parsed.params,
      }),
      [200],
    );
    signal.throwIfAborted();

    capturePlausibleEvent("agentphone_connect", {
      props: { channel: "agentphone" },
    });

    return result.body;
  },
);
