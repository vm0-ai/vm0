export const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";

const DAILY_RATE_KEY_PREFIX = "audio_input_daily";
const DAILY_DURATION_KEY_PREFIX = "audio_input_dur";

export function sttDailyRateKey(date: Date): string {
  return `${DAILY_RATE_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}

export function sttDailyDurationKey(date: Date): string {
  return `${DAILY_DURATION_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}
