import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  zeroModelUsageRankingContract,
  type ModelUsageRankingRange,
} from "@vm0/api-contracts/contracts/zero-model-usage-ranking";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";

const internalModelUsageRankingRange$ = state<ModelUsageRankingRange>("7d");
const internalModelUsageRankingOpen$ = state(false);

export const modelUsageRankingRange$ = computed((get) => {
  return get(internalModelUsageRankingRange$);
});

export const modelUsageRankingOpen$ = computed((get) => {
  return get(internalModelUsageRankingOpen$);
});

export const modelUsageRankingEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.ModelUsageRanking] ?? false;
});

export const setModelUsageRankingRange$ = command(
  ({ set }, range: ModelUsageRankingRange) => {
    set(internalModelUsageRankingRange$, range);
  },
);

export const setModelUsageRankingOpen$ = command(({ set }, open: boolean) => {
  set(internalModelUsageRankingOpen$, open);
});

export const modelUsageRankingAsync$ = computed(async (get) => {
  const open = get(internalModelUsageRankingOpen$);
  const enabled = await get(modelUsageRankingEnabled$);
  const range = get(modelUsageRankingRange$);
  if (!open || !enabled) {
    return null;
  }
  const createClient = get(zeroClient$);
  const client = createClient(zeroModelUsageRankingContract);
  const result = await accept(client.get({ query: { range } }), [200], {
    toast: false,
  });
  return result.body;
});
