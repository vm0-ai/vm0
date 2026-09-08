import { computed, type Computed } from "ccstate";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq } from "drizzle-orm";

import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
} from "../context/usage-pricing-resolution";
import { db$ } from "../external/db";

interface IntroVideoAgentPricingRow {
  readonly provider: "heygen-video-agent";
  readonly category: "output_video_seconds";
  readonly unitPrice: number;
  readonly unitSize: number;
}

export const introVideoAgentPricing$: Computed<
  Promise<IntroVideoAgentPricingRow | null>
> = computed(async (get): Promise<IntroVideoAgentPricingRow | null> => {
  const db = get(db$);
  const provider = resolveUsagePricingProvider(
    get(usagePricingResolution$),
    "video",
    "heygen-video-agent",
  );
  const [row] = await db
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, provider),
        eq(usagePricing.category, "output_video_seconds"),
      ),
    )
    .limit(1);

  return row
    ? {
        provider: "heygen-video-agent",
        category: "output_video_seconds",
        ...row,
      }
    : null;
});
