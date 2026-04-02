import { command, computed, state } from "ccstate";
import type { PermissionPolicy } from "./firewalls.ts";

// ---------------------------------------------------------------------------
// Firewall permissions dialog form state
// ---------------------------------------------------------------------------

const internalAllPolicies$ = state<
  Record<string, Record<string, PermissionPolicy>>
>({});
export const firewallAllPolicies$ = computed((get) => {
  return get(internalAllPolicies$);
});

const internalInitialized$ = state(false);

export const initFirewallPolicies$ = command(
  (
    { get, set },
    policies: Record<string, Record<string, PermissionPolicy>>,
  ) => {
    if (get(internalInitialized$)) {
      return;
    }
    set(internalInitialized$, true);
    set(internalAllPolicies$, policies);
  },
);

export const setFirewallPolicy$ = command(
  ({ get, set }, ref: string, name: string, policy: PermissionPolicy) => {
    const all = get(internalAllPolicies$);
    const current = all[ref] ?? {};
    set(internalAllPolicies$, {
      ...all,
      [ref]: { ...current, [name]: policy },
    });
  },
);

export const setFirewallAllPolicies$ = command(
  ({ get, set }, ref: string, policies: Record<string, PermissionPolicy>) => {
    const all = get(internalAllPolicies$);
    set(internalAllPolicies$, { ...all, [ref]: policies });
  },
);

// ---------------------------------------------------------------------------
// Scroll tracking
// ---------------------------------------------------------------------------

const internalScrolled$ = state(false);
export const firewallScrolled$ = computed((get) => {
  return get(internalScrolled$);
});
export const setFirewallScrolled$ = command(({ set }, value: boolean) => {
  set(internalScrolled$, value);
});

// ---------------------------------------------------------------------------
// Expanded groups
// ---------------------------------------------------------------------------

const internalExpandedGroups$ = state<Set<string>>(new Set());
export const firewallExpandedGroups$ = computed((get) => {
  return get(internalExpandedGroups$);
});
export const toggleFirewallGroup$ = command(
  ({ get, set }, category: string) => {
    const prev = get(internalExpandedGroups$);
    const next = new Set(prev);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    set(internalExpandedGroups$, next);
  },
);

// ---------------------------------------------------------------------------
// Apply (save) command
// ---------------------------------------------------------------------------

export const applyFirewallPolicies$ = command(
  async (
    { get },
    onApply: (
      policies: Record<string, Record<string, PermissionPolicy>>,
    ) => Promise<void>,
    onClose: () => void,
    _signal: AbortSignal,
  ): Promise<void> => {
    const policies = get(internalAllPolicies$);
    await onApply(policies);
    onClose();
  },
);
