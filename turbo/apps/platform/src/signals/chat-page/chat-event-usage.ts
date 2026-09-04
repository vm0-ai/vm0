import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";

interface UsageBreakdownAccumulator {
  readonly kind: string;
  credits: number;
  readonly providers: Map<string, number>;
}

export function mergeChatEventUsagePayloads(
  usages: readonly ChatEventUsagePayload[],
): ChatEventUsagePayload | undefined {
  if (usages.length === 0) {
    return undefined;
  }

  let totalCredits = 0;
  let settledAt = "";
  const breakdownByKind = new Map<string, UsageBreakdownAccumulator>();

  for (const usage of usages) {
    totalCredits += usage.totalCredits;
    settledAt = usage.settledAt;

    for (const kindBreakdown of usage.breakdown) {
      let accumulator = breakdownByKind.get(kindBreakdown.kind);
      if (accumulator === undefined) {
        accumulator = {
          kind: kindBreakdown.kind,
          credits: 0,
          providers: new Map(),
        };
        breakdownByKind.set(kindBreakdown.kind, accumulator);
      }

      accumulator.credits += kindBreakdown.credits;

      for (const providerBreakdown of kindBreakdown.providers) {
        accumulator.providers.set(
          providerBreakdown.provider,
          (accumulator.providers.get(providerBreakdown.provider) ?? 0) +
            providerBreakdown.credits,
        );
      }
    }
  }

  return {
    version: 1,
    totalCredits,
    settledAt,
    breakdown: Array.from(breakdownByKind.values()).map((accumulator) => {
      return {
        kind: accumulator.kind,
        credits: accumulator.credits,
        providers: Array.from(accumulator.providers.entries()).map(
          ([provider, credits]) => {
            return { provider, credits };
          },
        ),
      };
    }),
  };
}
