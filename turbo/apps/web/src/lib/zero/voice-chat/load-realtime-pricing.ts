import { and, eq, inArray } from "drizzle-orm";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import {
  REALTIME_PROVIDER,
  REALTIME_TOKEN_CATEGORIES,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_TOKEN_CATEGORIES,
} from "../billing/model-usage-categories";

const REALTIME_KIND = "model";

interface PricingRow {
  unitPrice: number;
  unitSize: number;
}

type PricingMap = Map<string, PricingRow>;

interface RealtimeBillingPricing {
  realtime: PricingMap;
  transcription: PricingMap;
  /** Empty if every required category is configured. */
  missing: string[];
}

/**
 * Load realtime + transcription pricing rows in one DB round-trip.
 *
 * `missing` lists `${provider}.${category}` strings for any required
 * row that is absent. Callers should map a non-empty `missing` array to
 * an HTTP 503 NOT_CONFIGURED response.
 *
 * Constants come from `lib/zero/billing/model-usage-categories.ts`
 * (centralised by #12138).
 */
export async function loadRealtimeBillingPricing(): Promise<RealtimeBillingPricing> {
  const rows = await globalThis.services.db
    .select({
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, REALTIME_KIND),
        inArray(usagePricing.provider, [
          REALTIME_PROVIDER,
          TRANSCRIPTION_PROVIDER,
        ]),
      ),
    );

  const realtime: PricingMap = new Map();
  const transcription: PricingMap = new Map();
  for (const row of rows) {
    const target =
      row.provider === REALTIME_PROVIDER ? realtime : transcription;
    target.set(row.category, {
      unitPrice: row.unitPrice,
      unitSize: row.unitSize,
    });
  }

  const missing: string[] = [];
  for (const c of REALTIME_TOKEN_CATEGORIES) {
    if (!realtime.has(c)) missing.push(`${REALTIME_PROVIDER}.${c}`);
  }
  for (const c of TRANSCRIPTION_TOKEN_CATEGORIES) {
    if (!transcription.has(c)) missing.push(`${TRANSCRIPTION_PROVIDER}.${c}`);
  }

  return { realtime, transcription, missing };
}
