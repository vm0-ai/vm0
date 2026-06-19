import { command, computed, state } from "ccstate";
import type { FirewallPermissionDetailMetadata } from "@vm0/connectors/firewall-metadata";
import type { FirewallPolicies } from "@vm0/connectors/firewall-types";

import {
  createEmptyPermissionDraftIntent,
  type PermissionDraftIntent,
} from "./permission-draft-intent.ts";

interface PermissionDrawerUiState {
  readonly key: string | null;
  readonly draft: PermissionDraftIntent;
  readonly expandedGroups: ReadonlySet<string>;
  readonly visibleCounts: Readonly<Record<string, number>>;
  readonly search: string;
  readonly scrolled: boolean;
}

interface PermissionDrawerApplyOptions {
  readonly metadata: FirewallPermissionDetailMetadata;
  readonly initialPolicies: FirewallPolicies;
}

type PermissionDrawerApply = (
  intent: PermissionDraftIntent,
  options: PermissionDrawerApplyOptions,
) => Promise<void>;

interface ApplyPermissionDrawerParams {
  readonly intent: PermissionDraftIntent;
  readonly metadata: FirewallPermissionDetailMetadata;
  readonly initialPolicies: FirewallPolicies;
  readonly onApply: PermissionDrawerApply;
  readonly onClose: () => void;
}

function emptyPermissionDrawerUiState(
  key: string | null,
): PermissionDrawerUiState {
  return {
    key,
    draft: createEmptyPermissionDraftIntent(),
    expandedGroups: new Set(),
    visibleCounts: {},
    search: "",
    scrolled: false,
  };
}

export function permissionDrawerUiStateForKey(
  current: PermissionDrawerUiState,
  key: string,
): PermissionDrawerUiState {
  return current.key === key ? current : emptyPermissionDrawerUiState(key);
}

function stateForKey(
  current: PermissionDrawerUiState,
  key: string,
): PermissionDrawerUiState {
  return current.key === key ? current : emptyPermissionDrawerUiState(key);
}

const internalPermissionDrawerUiState$ = state<PermissionDrawerUiState>(
  emptyPermissionDrawerUiState(null),
);

export const permissionDrawerUiState$ = computed((get) => {
  return get(internalPermissionDrawerUiState$);
});

export const updatePermissionDrawerDraft$ = command(
  (
    { get, set },
    key: string,
    update: (current: PermissionDraftIntent) => PermissionDraftIntent,
  ) => {
    const current = stateForKey(get(internalPermissionDrawerUiState$), key);
    set(internalPermissionDrawerUiState$, {
      ...current,
      draft: update(current.draft),
    });
  },
);

export const togglePermissionDrawerGroup$ = command(
  ({ get, set }, key: string, category: string) => {
    const current = stateForKey(get(internalPermissionDrawerUiState$), key);
    const expandedGroups = new Set(current.expandedGroups);
    if (expandedGroups.has(category)) {
      expandedGroups.delete(category);
    } else {
      expandedGroups.add(category);
    }
    set(internalPermissionDrawerUiState$, {
      ...current,
      expandedGroups,
    });
  },
);

export const showMorePermissionDrawerRows$ = command(
  ({ get, set }, key: string, rowKey: string, pageSize: number) => {
    const current = stateForKey(get(internalPermissionDrawerUiState$), key);
    set(internalPermissionDrawerUiState$, {
      ...current,
      visibleCounts: {
        ...current.visibleCounts,
        [rowKey]: (current.visibleCounts[rowKey] ?? pageSize) + pageSize,
      },
    });
  },
);

export const setPermissionDrawerSearch$ = command(
  ({ get, set }, key: string, search: string) => {
    const current = stateForKey(get(internalPermissionDrawerUiState$), key);
    const visibleCounts = { ...current.visibleCounts };
    delete visibleCounts.permissions;
    set(internalPermissionDrawerUiState$, {
      ...current,
      search,
      visibleCounts,
    });
  },
);

export const setPermissionDrawerScrolled$ = command(
  ({ get, set }, key: string, scrolled: boolean) => {
    const current = stateForKey(get(internalPermissionDrawerUiState$), key);
    set(internalPermissionDrawerUiState$, {
      ...current,
      scrolled,
    });
  },
);

export const resetPermissionDrawerState$ = command(({ set }) => {
  set(internalPermissionDrawerUiState$, emptyPermissionDrawerUiState(null));
});

export const applyPermissionDrawer$ = command(
  async (
    _ctx,
    params: ApplyPermissionDrawerParams,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    await params.onApply(params.intent, {
      metadata: params.metadata,
      initialPolicies: params.initialPolicies,
    });
    signal.throwIfAborted();
    params.onClose();
  },
);
