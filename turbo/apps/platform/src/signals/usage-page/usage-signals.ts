import { computed } from "ccstate";
import { fetch$ } from "../fetch.ts";

interface MemberUsage {
  userId: string;
  email: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  creditsCharged: number;
}

interface UsageMembersResponse {
  period: { start: string; end: string } | null;
  members: MemberUsage[];
}

/**
 * Async computed signal that fetches per-member usage data.
 * Returns null on error or while the fetch$ dependency is pending.
 */
export const usageMembersAsync$ = computed(async (get) => {
  const fetchFn = await get(fetch$);
  const response = await fetchFn("/api/usage/members");
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as UsageMembersResponse;
  return data;
});
