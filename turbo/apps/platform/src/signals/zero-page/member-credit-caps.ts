import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { usageMembersAsync$ } from "../usage-page/usage-signals.ts";

interface MemberCreditCap {
  creditCap: number | null;
  creditEnabled: boolean;
}

const memberCreditCapsReload$ = state(0);

/**
 * Fetches credit caps for all members returned by usageMembersAsync$.
 * Returns a Map keyed by userId.
 */
export const memberCreditCaps$ = computed(async (get) => {
  get(memberCreditCapsReload$);
  const usage = await get(usageMembersAsync$);
  const fetchFn = get(fetch$);

  const caps = new Map<string, MemberCreditCap>();

  // Fetch caps for all members in parallel
  const results = await Promise.all(
    usage.members.map(async (member) => {
      const response = await fetchFn(
        `/api/zero/org/members/credit-cap?userId=${encodeURIComponent(member.userId)}`,
      );
      if (!response.ok) {
        return { userId: member.userId, cap: null };
      }
      const data = (await response.json()) as {
        userId: string;
        creditCap: number | null;
        creditEnabled: boolean;
      };
      return {
        userId: member.userId,
        cap: { creditCap: data.creditCap, creditEnabled: data.creditEnabled },
      };
    }),
  );

  for (const result of results) {
    if (result.cap) {
      caps.set(result.userId, result.cap);
    }
  }

  return caps;
});

/**
 * Command to set/clear a member's credit cap.
 * Invalidates the caps cache after mutation.
 */
export const setMemberCreditCap$ = command(
  async (
    { get, set },
    params: { userId: string; creditCap: number | null },
  ) => {
    const fetchFn = get(fetch$);
    await fetchFn("/api/zero/org/members/credit-cap", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    set(memberCreditCapsReload$, (x) => x + 1);
  },
);
