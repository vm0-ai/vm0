import type {
  UsagePackCatalogItem,
  UsagePackUsd,
} from "@okouai/api-contracts/contracts/billing";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";

export function usagePackOptionLabel(item: UsagePackCatalogItem): string {
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

export function parseUsagePackOption(
  value: string,
  catalog: readonly UsagePackCatalogItem[],
): UsagePackUsd {
  const item = catalog.find((candidate) => {
    return String(candidate.usagePackUsd) === value;
  });
  if (!item) {
    throw new Error(`Unknown member usage selection: ${value}`);
  }
  return item.usagePackUsd;
}
