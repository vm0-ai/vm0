import { computed, state, command } from "ccstate";
import { zeroUsageInsightContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { userPreferences$ } from "../zero-page/settings/user-preferences.ts";
import { accept } from "../../lib/accept.ts";

export type InsightRange = "24h" | "7d" | "28d";
export type InsightGroupBy = "source" | "agent";
export type InsightMetric = "credits" | "tokens";

const internalRange$ = state<InsightRange>("7d");
const internalGroupBy$ = state<InsightGroupBy>("source");
const internalMetric$ = state<InsightMetric>("credits");

export const range$ = computed((get) => {
  return get(internalRange$);
});

export const groupBy$ = computed((get) => {
  return get(internalGroupBy$);
});

export const metric$ = computed((get) => {
  return get(internalMetric$);
});

export const setRange$ = command(({ set }, range: InsightRange) => {
  set(internalRange$, range);
});

export const setGroupBy$ = command(({ set }, groupBy: InsightGroupBy) => {
  set(internalGroupBy$, groupBy);
});

export const setMetric$ = command(({ set }, metric: InsightMetric) => {
  set(internalMetric$, metric);
});

const tz$ = computed(async (get) => {
  const prefs = await get(userPreferences$);
  return prefs.timezone ?? "UTC";
});

export const usageInsightAsync$ = computed(async (get) => {
  const range = get(range$);
  const groupBy = get(groupBy$);
  const tz = await get(tz$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageInsightContract);
  const result = await accept(
    client.get({ query: { range, groupBy, tz } }),
    [200],
    { toast: false },
  );
  return result.body;
});
