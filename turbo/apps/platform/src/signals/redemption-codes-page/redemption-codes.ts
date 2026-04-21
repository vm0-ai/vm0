import { command, computed, state } from "ccstate";
import {
  zeroRedemptionCodesListContract,
  zeroRedemptionCodesMintContract,
  type ListRedemptionCodesResponse,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

interface MintedCode {
  code: string;
  creditsPerCode: number;
  expiresAt: string;
}

const internalMintedCodes$ = state<MintedCode[]>([]);
export const mintedCodes$ = computed((get) => {
  return get(internalMintedCodes$);
});

// Form inputs kept as ccstate state (direct export is linted; wrap with accessors).

const internalMintCreditsInput$ = state("10000");
export const mintCreditsInput$ = computed((get) => {
  return get(internalMintCreditsInput$);
});
export const setMintCreditsInput$ = command(({ set }, value: string) => {
  set(internalMintCreditsInput$, value);
});

const internalMintQuantityInput$ = state("1");
export const mintQuantityInput$ = computed((get) => {
  return get(internalMintQuantityInput$);
});
export const setMintQuantityInput$ = command(({ set }, value: string) => {
  set(internalMintQuantityInput$, value);
});

export const mintCodes$ = command(
  async (
    { get, set },
    input: { creditsPerCode: number; quantity: number },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroRedemptionCodesMintContract);
    signal.throwIfAborted();
    const response = await client.mint({ body: input });
    signal.throwIfAborted();
    const result = await accept(Promise.resolve(response), [200]);
    signal.throwIfAborted();
    set(internalMintedCodes$, result.body.codes);
    // Invalidate the history cache so the newly minted rows show up on the
    // History tab without a manual refresh.
    set(reloadMintedCodesHistory$);
    return result.body;
  },
);

// ---------------------------------------------------------------------------
// History (staff-only list of minted codes + redemption status)
// ---------------------------------------------------------------------------

export type MintedCodeHistoryRow = ListRedemptionCodesResponse["codes"][number];

const historyReload$ = state(0);

export const mintedCodesHistory$ = computed(
  async (get): Promise<MintedCodeHistoryRow[]> => {
    get(historyReload$);
    const createClient = get(zeroClient$);
    const client = createClient(zeroRedemptionCodesListContract);
    const result = await accept(client.list(), [200]);
    return result.body.codes;
  },
);

export const reloadMintedCodesHistory$ = command(({ set }) => {
  set(historyReload$, (x) => {
    return x + 1;
  });
});

// ---------------------------------------------------------------------------
// Tab state (Mint | History)
// ---------------------------------------------------------------------------

export type RedemptionCodesTab = "mint" | "history";

const internalActiveTab$ = state<RedemptionCodesTab>("mint");
export const activeTab$ = computed((get) => {
  return get(internalActiveTab$);
});
export const setActiveTab$ = command(({ set }, tab: RedemptionCodesTab) => {
  set(internalActiveTab$, tab);
});
