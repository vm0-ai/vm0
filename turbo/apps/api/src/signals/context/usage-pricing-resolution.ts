import { command, computed, state, type Computed } from "ccstate";

export interface UsagePricingProviderResolution {
  readonly kind: string;
  readonly provider: string;
  readonly lookupProvider: string;
}

export type UsagePricingResolution = readonly UsagePricingProviderResolution[];

const innerUsagePricingResolution$ = state<UsagePricingResolution>([]);

export const usagePricingResolution$: Computed<UsagePricingResolution> =
  computed((get) => {
    return get(innerUsagePricingResolution$);
  });

export const setUsagePricingResolution$ = command(
  ({ set }, resolution: UsagePricingResolution): void => {
    set(innerUsagePricingResolution$, resolution);
  },
);

export function resolveUsagePricingProvider(
  resolution: UsagePricingResolution,
  kind: string,
  provider: string,
): string {
  return (
    resolution.find((entry) => {
      return entry.kind === kind && entry.provider === provider;
    })?.lookupProvider ?? provider
  );
}

export function canonicalUsagePricingProvider(
  resolution: UsagePricingResolution,
  kind: string,
  lookupProvider: string,
): string {
  return (
    resolution.find((entry) => {
      return entry.kind === kind && entry.lookupProvider === lookupProvider;
    })?.provider ?? lookupProvider
  );
}
