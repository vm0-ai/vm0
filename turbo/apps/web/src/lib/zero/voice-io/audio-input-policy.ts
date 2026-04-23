import type { OrgTier } from "@vm0/core";
import { getCount } from "../behavior/user-behavior-count-service";

export const AUDIO_INPUT_FREE_QUOTA = 10;
export const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";

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
