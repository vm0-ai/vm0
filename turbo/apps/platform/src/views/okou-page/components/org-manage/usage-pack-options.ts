import type { MemberUsagePackOption } from "../../../../signals/okou-page/settings/usage-pack-pricing-state.ts";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";

export function usagePackOptionLabel(item: MemberUsagePackOption): string {
  if (item.usagePackUsd === 0) {
    return i18n.t(($) => {
      return $.billing.plans.usagePacks.noPackage;
    });
  }
  const discount = Math.round((item.bonusCredits / item.totalCredits) * 100);
  return i18n.t(
    ($) => {
      return $.billing.plans.usagePacks.packOption;
    },
    {
      credits: formatLocalizedNumber(item.totalCredits),
      discount,
      price: formatUsd(item.priceUsd, 0),
    },
  );
}

export function parseUsagePackOption<T extends number>(
  value: string,
  catalog: readonly { readonly usagePackUsd: T }[],
): T {
  const item = catalog.find((candidate) => {
    return String(candidate.usagePackUsd) === value;
  });
  if (!item) {
    throw new Error(`Unknown member usage selection: ${value}`);
  }
  return item.usagePackUsd;
}
