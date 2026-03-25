import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { fetch$ } from "../fetch.ts";
import { usageMembersAsync$ } from "../usage-page/usage-signals.ts";
import { toast } from "@vm0/ui/components/ui/sonner";

interface MemberCreditCap {
  creditCap: number | null;
  creditEnabled: boolean;
}

const memberCreditCapsReload$ = state(0);

/**
 * Fetches credit caps for all members returned by usageMembersAsync$.
 * Returns a Map keyed by userId.
 */
const memberCreditCaps$ = computed(async (get) => {
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
const setMemberCreditCap$ = command(
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

// ---------------------------------------------------------------------------
// Per-member signal factory
// ---------------------------------------------------------------------------

export interface MemberCapSetting {
  userId: string;
  email: string;
  creditsCharged: number;
  creditCap: number | null;
  editMode$: State<boolean>;
  value$: State<string>;
  savingPromise$: Computed<Promise<unknown> | null>;
  save$: Command<void, []>;
  clearCap$: Command<void, []>;
  enterEditMode$: Command<void, []>;
  exitEditMode$: Command<void, []>;
  setValue$: Command<void, [string]>;
}

function createMemberCapSetting(
  member: { userId: string; email: string; creditsCharged: number },
  creditCap: number | null,
): MemberCapSetting {
  const editMode$ = state(false);
  const value$ = state(creditCap?.toString() ?? "");
  const internalSavingPromise$ = state<Promise<unknown> | null>(null);
  const savingPromise$ = computed((get) => get(internalSavingPromise$));

  const save$ = command(({ get, set }) => {
    const rawValue = get(value$);
    const parsed =
      rawValue.trim() === "" ? null : Number.parseInt(rawValue, 10);
    if (parsed !== null && (Number.isNaN(parsed) || parsed <= 0)) {
      return;
    }

    const promise = (async () => {
      await set(setMemberCreditCap$, {
        userId: member.userId,
        creditCap: parsed,
      });
    })();

    set(internalSavingPromise$, promise);

    promise
      .then(() => {
        set(internalSavingPromise$, null);
        set(editMode$, false);
      })
      .catch(() => {
        set(internalSavingPromise$, null);
        toast.error("Failed to update credit cap. Please try again.");
      });
  });

  const clearCap$ = command(({ set }) => {
    const promise = (async () => {
      await set(setMemberCreditCap$, {
        userId: member.userId,
        creditCap: null,
      });
    })();

    set(internalSavingPromise$, promise);

    promise
      .then(() => {
        set(internalSavingPromise$, null);
        set(editMode$, false);
      })
      .catch(() => {
        set(internalSavingPromise$, null);
        toast.error("Failed to clear credit cap. Please try again.");
      });
  });

  const enterEditMode$ = command(({ set }) => {
    set(value$, creditCap?.toString() ?? "");
    set(editMode$, true);
  });

  const exitEditMode$ = command(({ set }) => {
    set(editMode$, false);
  });

  const setValue$ = command(({ set }, newValue: string) => {
    set(value$, newValue);
  });

  return {
    userId: member.userId,
    email: member.email,
    creditsCharged: member.creditsCharged,
    creditCap,
    editMode$,
    value$,
    savingPromise$,
    save$,
    clearCap$,
    enterEditMode$,
    exitEditMode$,
    setValue$,
  };
}

/**
 * Signal holding a cache of MemberCapSetting objects keyed by userId.
 * Preserved across recomputations so that in-progress edits
 * (edit mode, typed input values, saving state) are not destroyed
 * when another member's cap is saved.
 */
const memberCapSettingCache$ = state(new Map<string, MemberCapSetting>());

/**
 * Async computed that fetches members + caps together,
 * returns MemberCapSetting[] with per-member signal bundles.
 * Reuses existing MemberCapSetting objects when the creditCap hasn't changed,
 * preserving in-progress edit state for other rows.
 */
export const creditsMemberList$ = computed(async (get) => {
  const usage = await get(usageMembersAsync$);
  const caps = await get(memberCreditCaps$);
  const cache = get(memberCapSettingCache$);

  return usage.members.map((member) => {
    const cap = caps.get(member.userId);
    const creditCap = cap?.creditCap ?? null;

    const cached = cache.get(member.userId);
    if (cached && cached.creditCap === creditCap) {
      return cached;
    }

    const setting = createMemberCapSetting(member, creditCap);
    cache.set(member.userId, setting);
    return setting;
  });
});
