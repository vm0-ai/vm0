import { command, computed, state } from "ccstate";
import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";

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

interface InitialPermissionDrawerUiState {
  readonly draft?: PermissionDraftIntent;
  readonly search?: string;
}

interface PermissionDrawerApplyOptions {
  readonly metadata: PublicConnectorCatalogPermissionDetail;
}

type PermissionDrawerApply = (
  intent: PermissionDraftIntent,
  options: PermissionDrawerApplyOptions,
) => Promise<void>;

interface ApplyPermissionDrawerParams {
  readonly intent: PermissionDraftIntent;
  readonly metadata: PublicConnectorCatalogPermissionDetail;
  readonly onApply: PermissionDrawerApply;
  readonly onClose: () => void;
}

function emptyPermissionDrawerUiState(
  key: string | null,
  initial?: InitialPermissionDrawerUiState,
): PermissionDrawerUiState {
  return {
    key,
    draft: initial?.draft ?? createEmptyPermissionDraftIntent(),
    expandedGroups: new Set(),
    visibleCounts: {},
    search: initial?.search ?? "",
    scrolled: false,
  };
}

export function permissionDrawerUiStateForKey(
  current: PermissionDrawerUiState,
  key: string,
  initial?: InitialPermissionDrawerUiState,
): PermissionDrawerUiState {
  return current.key === key
    ? current
    : emptyPermissionDrawerUiState(key, initial);
}

function stateForKey(
  current: PermissionDrawerUiState,
  key: string,
  initial?: InitialPermissionDrawerUiState,
): PermissionDrawerUiState {
  return current.key === key
    ? current
    : emptyPermissionDrawerUiState(key, initial);
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
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
    set(internalPermissionDrawerUiState$, {
      ...current,
      draft: update(current.draft),
    });
  },
);

export const togglePermissionDrawerGroup$ = command(
  (
    { get, set },
    key: string,
    category: string,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
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
  (
    { get, set },
    key: string,
    rowKey: string,
    pageSize: number,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
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
  (
    { get, set },
    key: string,
    search: string,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
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
  (
    { get, set },
    key: string,
    scrolled: boolean,
    initial?: InitialPermissionDrawerUiState,
  ) => {
    const current = stateForKey(
      get(internalPermissionDrawerUiState$),
      key,
      initial,
    );
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
    await params.onApply(params.intent, { metadata: params.metadata });
    signal.throwIfAborted();
    params.onClose();
  },
);
