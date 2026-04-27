import { command, computed, state } from "ccstate";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";
import type { PermissionPolicy } from "./permissions.ts";

// ---------------------------------------------------------------------------
// Permissions dialog form state
// ---------------------------------------------------------------------------

const internalAllPolicies$ = state<
  Record<string, Record<string, PermissionPolicy>>
>({});
export const permissionAllPolicies$ = computed((get) => {
  return get(internalAllPolicies$);
});

const internalUnknownPolicy$ = state<FirewallPolicyValue>("allow");
export const permissionUnknownPolicy$ = computed((get) => {
  return get(internalUnknownPolicy$);
});
export const setPermissionUnknownPolicy$ = command(
  ({ set }, value: FirewallPolicyValue) => {
    set(internalUnknownPolicy$, value);
  },
);

const internalInitialized$ = state(false);

export const initPermissionPolicies$ = command(
  (
    { get, set },
    policies: Record<string, Record<string, PermissionPolicy>>,
    unknownPolicy: FirewallPolicyValue,
  ) => {
    if (get(internalInitialized$)) {
      return;
    }
    set(internalInitialized$, true);
    set(internalAllPolicies$, policies);
    set(internalUnknownPolicy$, unknownPolicy);
  },
);

export const setPermissionPolicy$ = command(
  ({ get, set }, ref: string, name: string, policy: PermissionPolicy) => {
    const all = get(internalAllPolicies$);
    const current = all[ref] ?? {};
    set(internalAllPolicies$, {
      ...all,
      [ref]: { ...current, [name]: policy },
    });
  },
);

export const setPermissionAllPolicies$ = command(
  ({ get, set }, ref: string, policies: Record<string, PermissionPolicy>) => {
    const all = get(internalAllPolicies$);
    set(internalAllPolicies$, { ...all, [ref]: policies });
  },
);

// ---------------------------------------------------------------------------
// Scroll tracking
// ---------------------------------------------------------------------------

const internalScrolled$ = state(false);
export const permissionScrolled$ = computed((get) => {
  return get(internalScrolled$);
});
export const setPermissionScrolled$ = command(({ set }, value: boolean) => {
  set(internalScrolled$, value);
});

// ---------------------------------------------------------------------------
// Expanded groups
// ---------------------------------------------------------------------------

const internalExpandedGroups$ = state<Set<string>>(new Set());
export const permissionExpandedGroups$ = computed((get) => {
  return get(internalExpandedGroups$);
});
export const togglePermissionGroup$ = command(
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

export const applyPermissionPolicies$ = command(
  async (
    { get },
    onApply: (
      policies: Record<string, Record<string, PermissionPolicy>>,
      unknownPolicy: FirewallPolicyValue,
    ) => Promise<void>,
    onClose: () => void,
    _signal: AbortSignal,
  ): Promise<void> => {
    const policies = get(internalAllPolicies$);
    const unknownPolicy = get(internalUnknownPolicy$);
    await onApply(policies, unknownPolicy);
    onClose();
  },
);
