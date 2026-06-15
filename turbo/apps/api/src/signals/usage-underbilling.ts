type UsageUnderbillingClass = "confirmed" | "risk";

interface UsageUnderbillingFields {
  readonly type: "usage_underbilling";
  readonly reason: string;
  readonly underbilling_class: UsageUnderbillingClass;
  readonly component: "api";
}

export function usageUnderbillingFields(
  reason: string,
  underbillingClass: UsageUnderbillingClass,
): UsageUnderbillingFields {
  return {
    type: "usage_underbilling",
    reason,
    underbilling_class: underbillingClass,
    component: "api",
  };
}
