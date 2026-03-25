import { command, computed, state, type Command, type State } from "ccstate";
import { zeroMemberCreditCapContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
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
const memberCreditCaps$ = computed(async (get) => {
  get(memberCreditCapsReload$);
  const usage = await get(usageMembersAsync$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroMemberCreditCapContract);

  const caps = new Map<string, MemberCreditCap>();

  // Fetch caps for all members in parallel
  const results = await Promise.all(
    usage.members.map(async (member) => {
      const result = await client.get({
        query: { userId: member.userId },
      });
      if (result.status !== 200) {
        return { userId: member.userId, cap: null };
      }
      return {
        userId: member.userId,
        cap: {
          creditCap: result.body.creditCap,
          creditEnabled: result.body.creditEnabled,
        },
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
    _signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroMemberCreditCapContract);
    await client.set({ body: params });
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
  save$: Command<Promise<void>, [AbortSignal]>;
  clearCap$: Command<Promise<void>, [AbortSignal]>;
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

  const save$ = command(async ({ get, set }, signal: AbortSignal) => {
    const rawValue = get(value$);
    const parsed =
      rawValue.trim() === "" ? null : Number.parseInt(rawValue, 10);
    if (parsed !== null && (Number.isNaN(parsed) || parsed <= 0)) {
      return;
    }

    await set(
      setMemberCreditCap$,
      { userId: member.userId, creditCap: parsed },
      signal,
    );
    signal.throwIfAborted();
    set(editMode$, false);
  });

  const clearCap$ = command(async ({ set }, signal: AbortSignal) => {
    await set(
      setMemberCreditCap$,
      { userId: member.userId, creditCap: null },
      signal,
    );
    signal.throwIfAborted();
    set(editMode$, false);
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
