import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";

export const AUDIO_INPUT_FREE_QUOTA = 10;
export const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";

const DAILY_RATE_KEY_PREFIX = "audio_input_daily";
const DAILY_DURATION_KEY_PREFIX = "audio_input_dur";

export const DAILY_RATE_LIMITS: Readonly<Record<OrgTier, number>> = {
  free: 10,
  "limited-free-1": 10,
  "pro-suspend": 0,
  pro: 300,
  team: 500,
  custom: 500,
};

export const DAILY_DURATION_LIMITS: Readonly<Record<OrgTier, number>> = {
  free: 10 * 60,
  "limited-free-1": 10 * 60,
  "pro-suspend": 0,
  pro: 200 * 60,
  team: 500 * 60,
  custom: 500 * 60,
};

export function sttDailyRateKey(date: Date): string {
  return `${DAILY_RATE_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}

export function sttDailyDurationKey(date: Date): string {
  return `${DAILY_DURATION_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}
