import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { getCount, getCounts } from "../behavior/user-behavior-count-service";

// Per-user lifetime quota (free tier only, existing behavior)
export const AUDIO_INPUT_FREE_QUOTA = 10;
export const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";

// Per-user daily request rate limits
export const DAILY_RATE_LIMITS: Record<OrgTier, number | null> = {
  free: 10,
  pro: 300,
  team: 500,
};

// Per-user daily audio duration limits (seconds)
// Pro:  200 min/day × $0.003 = $0.60/day → $18/month ceiling
// Team: 500 min/day × $0.003 = $1.50/day → $45/month per-user ceiling
export const DAILY_DURATION_LIMITS: Record<OrgTier, number | null> = {
  free: 10 * 60, // 10 minutes
  pro: 200 * 60, // 200 minutes
  team: 500 * 60, // 500 minutes
};

// Per-request maximum audio duration (seconds)
export const MAX_REQUEST_DURATION_SECONDS = 5 * 60; // 5 minutes

const DAILY_RATE_KEY_PREFIX = "audio_input_daily";
const DAILY_DURATION_KEY_PREFIX = "audio_input_dur";

interface AudioInputQuotaStatus {
  allowed: boolean;
  count: number;
  limit: number | null;
}

export async function checkAudioInputQuota(
  orgId: string,
  userId: string,
  orgTier: OrgTier,
): Promise<AudioInputQuotaStatus> {
  if (orgTier !== "free") {
    return { allowed: true, count: 0, limit: null };
  }
  const count = await getCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY);
  return {
    allowed: count < AUDIO_INPUT_FREE_QUOTA,
    count,
    limit: AUDIO_INPUT_FREE_QUOTA,
  };
}

export function dailyRateKey(date?: Date): string {
  const d = date ?? new Date();
  return `${DAILY_RATE_KEY_PREFIX}_${d.toISOString().slice(0, 10)}`;
}

export function dailyDurationKey(date?: Date): string {
  const d = date ?? new Date();
  return `${DAILY_DURATION_KEY_PREFIX}_${d.toISOString().slice(0, 10)}`;
}

/**
 * Batch-read both daily rate and duration counts in a single DB query.
 * Merged for performance — avoids two sequential round-trips.
 */
export async function getDailyCounts(
  orgId: string,
  userId: string,
): Promise<{ rateCount: number; durationSeconds: number }> {
  const keys = [dailyRateKey(), dailyDurationKey()];
  const counts = await getCounts(orgId, userId, keys);
  return {
    rateCount: counts[keys[0]!] ?? 0,
    durationSeconds: counts[keys[1]!] ?? 0,
  };
}
