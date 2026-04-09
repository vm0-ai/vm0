import { command, computed, state } from "ccstate";
import type { PermissionPolicy } from "./permissions.ts";

// ---------------------------------------------------------------------------
// Allow-unknown-endpoints toggle state
// ---------------------------------------------------------------------------

const internalAllowUnknown$ = state(false);
export const permissionAllowUnknown$ = computed((get) => {
  return get(internalAllowUnknown$);
});
export const setPermissionAllowUnknown$ = command(({ set }, value: boolean) => {
  set(internalAllowUnknown$, value);
});

// ---------------------------------------------------------------------------
// Permissions dialog form state
// ---------------------------------------------------------------------------

const internalAllPolicies$ = state<
  Record<string, Record<string, PermissionPolicy>>
>({});
export const permissionAllPolicies$ = computed((get) => {
  return get(internalAllPolicies$);
});

const internalInitialized$ = state(false);

export const initPermissionPolicies$ = command(
  (
    { get, set },
    policies: Record<string, Record<string, PermissionPolicy>>,
    allowUnknown: boolean,
  ) => {
    if (get(internalInitialized$)) {
      return;
    }
    set(internalInitialized$, true);
    set(internalAllPolicies$, policies);
    set(internalAllowUnknown$, allowUnknown);
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
      allowUnknown: boolean,
    ) => Promise<void>,
    onClose: () => void,
    _signal: AbortSignal,
  ): Promise<void> => {
    const policies = get(internalAllPolicies$);
    const allowUnknown = get(internalAllowUnknown$);
    await onApply(policies, allowUnknown);
    onClose();
  },
);
