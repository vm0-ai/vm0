import { z } from "zod";

// Shared with vm0-marketing. Keep Impact independent of immutable acquisition
// attribution: a returning customer can arrive through a newer partner click.
export const IMPACT_ATTRIBUTION_COOKIE = "okou_impact";
export const IMPACT_ATTRIBUTION_METADATA_KEY = "impact_attribution";
const IMPACT_ATTRIBUTION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export const impactAttributionSchema = z.object({
  clickId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/u),
  capturedAt: z.iso.datetime(),
});

export type ImpactAttribution = z.infer<typeof impactAttributionSchema>;

export function parseImpactAttribution(
  value: unknown,
  now: number,
): ImpactAttribution | undefined {
  const result = impactAttributionSchema.safeParse(value);
  if (!result.success) return undefined;
  const age = now - Date.parse(result.data.capturedAt);
  return age >= 0 && age < IMPACT_ATTRIBUTION_MAX_AGE_MS
    ? {
        ...result.data,
        capturedAt: new Date(result.data.capturedAt).toISOString(),
      }
    : undefined;
}

// Cookie/session storage use the same percent-encoded JSON wire format.
export function parseEncodedImpactAttribution(
  value: string | null | undefined,
  now: number,
): ImpactAttribution | undefined {
  if (!value) return undefined;
  try {
    return parseImpactAttribution(JSON.parse(decodeURIComponent(value)), now);
  } catch {
    return undefined;
  }
}
