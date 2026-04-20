import { command, computed, state } from "ccstate";
import { zeroRedemptionCodesRedeemContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalOpen$ = state(false);
const internalCode$ = state("");

export const redeemCodeDialogOpen$ = computed((get) => {
  return get(internalOpen$);
});

export const redeemCodeInput$ = computed((get) => {
  return get(internalCode$);
});

export const setRedeemCodeDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalOpen$, open);
  if (!open) {
    set(internalCode$, "");
  }
});

export const setRedeemCodeInput$ = command(({ set }, value: string) => {
  set(internalCode$, value);
});

/**
 * Call the redeem endpoint. Returns the granted credits and the new balance.
 * The dialog is responsible for surfacing success/error UX; this command
 * just does the network round-trip and clears the input on success.
 */
export const redeemCode$ = command(
  async (
    { get, set },
    code: string,
    signal: AbortSignal,
  ): Promise<{ credits: number; newBalance: number }> => {
    const client = get(zeroClient$)(zeroRedemptionCodesRedeemContract);
    signal.throwIfAborted();
    const response = await client.redeem({
      body: { code },
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    const result = await accept(Promise.resolve(response), [200]);
    signal.throwIfAborted();
    set(internalCode$, "");
    return result.body;
  },
);
