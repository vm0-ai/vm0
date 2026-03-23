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
 * Throws on non-OK responses so useLoadable enters hasError state.
 */
export const usageMembersAsync$ = computed(async (get) => {
  const fetchFn = await get(fetch$);
  const response = await fetchFn("/api/usage/members");
  if (!response.ok) {
    throw new Error(`Failed to fetch usage data: ${response.status}`);
  }
  const data = (await response.json()) as UsageMembersResponse;
  return data;
});
