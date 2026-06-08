import { command, computed, state } from "ccstate";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
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

const internalFormKey$ = state<string | null>(null);

interface ApplyPermissionPoliciesOptions {
  formKey: string;
  ref: string;
}

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

const internalGrantExpirationFormKey$ = state<string | null>(null);
const internalGrantExpirations$ = state<
  Record<string, UserPermissionGrantExpiresIn>
>({});
export const permissionGrantExpirations$ = computed((get) => {
  return get(internalGrantExpirations$);
});
export const setPermissionGrantExpiration$ = command(
  (
    { get, set },
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => {
    const current = get(internalGrantExpirations$);
    if (expiresIn === null) {
      const next = { ...current };
      delete next[permission];
      set(internalGrantExpirations$, next);
      return;
    }
    set(internalGrantExpirations$, {
      ...current,
      [permission]: expiresIn,
    });
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

export const initPermissionPolicies$ = command(
  (
    { get, set },
    formKey: string,
    policies: Record<string, Record<string, PermissionPolicy>>,
    unknownPolicy: FirewallPolicyValue,
  ) => {
    if (get(internalFormKey$) === formKey) {
      return;
    }
    set(internalFormKey$, formKey);
    set(internalAllPolicies$, policies);
    set(internalUnknownPolicy$, unknownPolicy);
    set(internalScrolled$, false);
    set(internalExpandedGroups$, new Set());
  },
);

export const initPermissionGrantExpirations$ = command(
  (
    { get, set },
    formKey: string,
    expirations: Record<string, UserPermissionGrantExpiresIn>,
  ) => {
    if (get(internalGrantExpirationFormKey$) === formKey) {
      return;
    }
    set(internalGrantExpirationFormKey$, formKey);
    set(internalGrantExpirations$, expirations);
  },
);

export const resetPermissionPolicies$ = command(
  ({ get, set }, formKey: string) => {
    if (get(internalFormKey$) !== formKey) {
      return;
    }
    set(internalFormKey$, null);
    set(internalAllPolicies$, {});
    set(internalUnknownPolicy$, "allow");
    set(internalScrolled$, false);
    set(internalExpandedGroups$, new Set());
  },
);

export const resetPermissionGrantExpirations$ = command(
  ({ get, set }, formKey: string) => {
    if (get(internalGrantExpirationFormKey$) !== formKey) {
      return;
    }
    set(internalGrantExpirationFormKey$, null);
    set(internalGrantExpirations$, {});
  },
);

// ---------------------------------------------------------------------------
// Apply (save) command
// ---------------------------------------------------------------------------

export const applyPermissionPolicies$ = command(
  async (
    { get },
    options: ApplyPermissionPoliciesOptions,
    onApply: (
      policies: Record<string, Record<string, PermissionPolicy>>,
      unknownPolicy: FirewallPolicyValue,
    ) => Promise<void>,
    onClose: () => void,
    _signal: AbortSignal,
  ): Promise<void> => {
    if (get(internalFormKey$) !== options.formKey) {
      throw new Error("Permission policies form is not initialized");
    }
    const policies = get(internalAllPolicies$);
    if (policies[options.ref] === undefined) {
      throw new Error("Permission policies form is missing connector state");
    }
    const unknownPolicy = get(internalUnknownPolicy$);
    await onApply(policies, unknownPolicy);
    onClose();
  },
);
