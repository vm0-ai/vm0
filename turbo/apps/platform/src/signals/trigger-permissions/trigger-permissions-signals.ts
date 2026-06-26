import { command, computed, state, type Command, type Computed } from "ccstate";
import type {
  UnattendedTriggerPermissionAction,
  UnattendedTriggerPermissionPolicy,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  createFirewallMetadataPolicyResolver,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";
import { pathParams$, searchParams$ } from "../route.ts";
import { workflowDetail } from "../workflows-page/workflows-signals.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

export const triggerPermissionsAgentId$ = computed((get) => {
  const agentId = get(pathParams$)?.agentId;
  return typeof agentId === "string" ? agentId : null;
});

export const triggerPermissionsWorkflowId$ = computed((get) => {
  const workflowId = get(pathParams$)?.workflowId;
  return typeof workflowId === "string" ? workflowId : null;
});

export const triggerPermissionsTriggerId$ = computed((get) => {
  const triggerId = get(pathParams$)?.triggerId;
  return typeof triggerId === "string" ? triggerId : null;
});

export const triggerPermissionsRef$ = computed((get) => {
  return get(searchParams$).get("ref") ?? null;
});

const internalTriggerPermissionsConnectorSearch$ = state("");

export const triggerPermissionsConnectorSearch$ = computed((get) => {
  return get(internalTriggerPermissionsConnectorSearch$);
});

export const setTriggerPermissionsConnectorSearch$ = command(
  ({ set }, value: string) => {
    set(internalTriggerPermissionsConnectorSearch$, value);
  },
);

interface TriggerPermissionEditorUiState {
  readonly key: string | null;
  readonly search: string;
  readonly expandedGroups: ReadonlySet<string>;
  readonly scrolled: boolean;
}

interface TriggerPermissionsDrawerConnectorState {
  readonly triggerId: string | null;
  readonly connectorRef: string | null;
}

function emptyTriggerPermissionEditorUiState({
  key,
  expandedGroups,
}: {
  readonly key: string | null;
  readonly expandedGroups?: readonly string[];
}): TriggerPermissionEditorUiState {
  return {
    key,
    search: "",
    expandedGroups: new Set(expandedGroups ?? []),
    scrolled: false,
  };
}

function triggerPermissionEditorStateForKey(
  current: TriggerPermissionEditorUiState,
  key: string,
): TriggerPermissionEditorUiState {
  return current.key === key
    ? current
    : emptyTriggerPermissionEditorUiState({ key });
}

export function triggerPermissionEditorUiStateForKey({
  current,
  key,
  expandedGroups,
}: {
  readonly current: TriggerPermissionEditorUiState;
  readonly key: string;
  readonly expandedGroups: readonly string[];
}): TriggerPermissionEditorUiState {
  return current.key === key
    ? current
    : emptyTriggerPermissionEditorUiState({ key, expandedGroups });
}

const internalTriggerPermissionEditorUiState$ =
  state<TriggerPermissionEditorUiState>(
    emptyTriggerPermissionEditorUiState({ key: null }),
  );

export const triggerPermissionEditorUiState$ = computed((get) => {
  return get(internalTriggerPermissionEditorUiState$);
});

export const setTriggerPermissionEditorSearch$ = command(
  ({ get, set }, key: string, search: string) => {
    const current = triggerPermissionEditorStateForKey(
      get(internalTriggerPermissionEditorUiState$),
      key,
    );
    set(internalTriggerPermissionEditorUiState$, { ...current, search });
  },
);

export const setTriggerPermissionEditorScrolled$ = command(
  ({ get, set }, key: string, scrolled: boolean) => {
    const current = triggerPermissionEditorStateForKey(
      get(internalTriggerPermissionEditorUiState$),
      key,
    );
    set(internalTriggerPermissionEditorUiState$, { ...current, scrolled });
  },
);

export const toggleTriggerPermissionEditorGroup$ = command(
  ({ get, set }, key: string, category: string) => {
    const current = triggerPermissionEditorStateForKey(
      get(internalTriggerPermissionEditorUiState$),
      key,
    );
    const expandedGroups = new Set(current.expandedGroups);
    if (expandedGroups.has(category)) {
      expandedGroups.delete(category);
    } else {
      expandedGroups.add(category);
    }
    set(internalTriggerPermissionEditorUiState$, {
      ...current,
      expandedGroups,
    });
  },
);

const internalTriggerPermissionsDrawerConnector$ =
  state<TriggerPermissionsDrawerConnectorState>({
    triggerId: null,
    connectorRef: null,
  });

const internalTriggerPermissionsDialogConnectorRef$ = state<string | null>(
  null,
);

export const triggerPermissionsDrawerConnector$ = computed((get) => {
  return get(internalTriggerPermissionsDrawerConnector$);
});

export const triggerPermissionsDialogConnectorRef$ = computed((get) => {
  return get(internalTriggerPermissionsDialogConnectorRef$);
});

export function triggerPermissionsDrawerConnectorForTrigger({
  current,
  triggerId,
  defaultConnectorRef,
}: {
  readonly current: TriggerPermissionsDrawerConnectorState;
  readonly triggerId: string;
  readonly defaultConnectorRef: string | null;
}): string | null {
  return current.triggerId === triggerId
    ? current.connectorRef
    : defaultConnectorRef;
}

export const setTriggerPermissionsDrawerConnector$ = command(
  ({ set }, triggerId: string, connectorRef: string | null) => {
    set(internalTriggerPermissionsDrawerConnector$, {
      triggerId,
      connectorRef,
    });
  },
);

export const setTriggerPermissionsDialogConnectorRef$ = command(
  ({ set }, connectorRef: string | null) => {
    set(internalTriggerPermissionsDialogConnectorRef$, connectorRef);
  },
);

// ---------------------------------------------------------------------------
// Trigger data (derived from the workflow detail's trigger list)
// ---------------------------------------------------------------------------

export const triggerPermissionsTrigger$ = computed(
  async (get): Promise<ZeroWorkflowTriggerSummary | null> => {
    const workflowId = get(triggerPermissionsWorkflowId$);
    const triggerId = get(triggerPermissionsTriggerId$);
    if (!workflowId || !triggerId) {
      return null;
    }
    const workflow = await get(workflowDetail(workflowId));
    if (!workflow) {
      return null;
    }
    return (
      workflow.triggers.find((trigger) => {
        return trigger.id === triggerId;
      }) ?? null
    );
  },
);

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

function toUnattendedPermissionAction(
  value: FirewallPolicyValue,
): UnattendedTriggerPermissionAction {
  return value === "allow" ? "allow" : "deny";
}

/**
 * Resolve the current action for a single connector permission from the
 * trigger's sparse policy overlaid on connector metadata defaults.
 */
export function resolveTriggerPermissionAction(
  policy: UnattendedTriggerPermissionPolicy | null,
  connectorRef: string,
  metadata: FirewallPermissionDetailMetadata,
  permission: string,
): UnattendedTriggerPermissionAction {
  const resolver = createFirewallMetadataPolicyResolver(
    metadata,
    policy?.[connectorRef]
      ? { permissionOverrides: policy[connectorRef].policies }
      : undefined,
  );
  return toUnattendedPermissionAction(resolver.permission(permission));
}

/**
 * Merge an edited connector's permission map into the trigger's full existing
 * policy, preserving every other connector. Permissions set back to the
 * connector metadata default are dropped so the stored policy stays minimal; a
 * connector left with no explicit permissions is removed entirely, and an empty
 * overall policy collapses to `null` (which clears the policy server-side).
 */
export function mergeConnectorPolicy(
  policy: UnattendedTriggerPermissionPolicy | null,
  connectorRef: string,
  metadata: FirewallPermissionDetailMetadata,
  policies: Record<string, UnattendedTriggerPermissionAction>,
): UnattendedTriggerPermissionPolicy | null {
  const next: UnattendedTriggerPermissionPolicy = {};
  for (const [ref, entry] of Object.entries(policy ?? {})) {
    if (ref !== connectorRef) {
      next[ref] = entry;
    }
  }
  const defaultResolver = createFirewallMetadataPolicyResolver(metadata);
  const nextPolicies: Record<string, UnattendedTriggerPermissionAction> = {};
  for (const [permission, action] of Object.entries(policies)) {
    const defaultAction = toUnattendedPermissionAction(
      defaultResolver.permission(permission),
    );
    if (action !== defaultAction) {
      nextPolicies[permission] = action;
    }
  }
  if (Object.keys(nextPolicies).length > 0) {
    next[connectorRef] = { policies: nextPolicies };
  }
  return Object.keys(next).length > 0 ? next : null;
}

// ---------------------------------------------------------------------------
// Editor state (per trigger + connector)
// ---------------------------------------------------------------------------

/**
 * Local, unsaved edits the user has toggled, keyed by permission name. Sparse:
 * only permissions the user actually changed appear here, so the displayed
 * action falls back to the trigger's saved policy for everything else. This
 * avoids seeding the full permission list from async data.
 */
export interface TriggerPermissionEditorSignals {
  readonly overrides$: Computed<
    Record<string, UnattendedTriggerPermissionAction>
  >;
  readonly setOverride$: Command<
    void,
    [permission: string, action: UnattendedTriggerPermissionAction]
  >;
}

function createTriggerPermissionEditorSignals(): TriggerPermissionEditorSignals {
  const internalOverrides$ = state<
    Record<string, UnattendedTriggerPermissionAction>
  >({});

  const overrides$ = computed((get) => {
    return get(internalOverrides$);
  });

  const setOverride$ = command(
    (
      { set },
      permission: string,
      action: UnattendedTriggerPermissionAction,
    ) => {
      set(internalOverrides$, (prev) => {
        return { ...prev, [permission]: action };
      });
    },
  );

  return { overrides$, setOverride$ };
}

function createTriggerPermissionEditorSignalsFactory(): (
  key: string,
) => TriggerPermissionEditorSignals {
  const cache = new Map<string, TriggerPermissionEditorSignals>();
  return (key: string) => {
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const signals = createTriggerPermissionEditorSignals();
    cache.set(key, signals);
    return signals;
  };
}

export const triggerPermissionEditorSignalsForKey =
  createTriggerPermissionEditorSignalsFactory();

/**
 * Editor signals for the active trigger + connector. ccstate memoizes the
 * computed, so the same signal group is reused until the trigger or connector
 * changes, at which point a fresh group (with empty overrides) is created.
 */
export const currentTriggerPermissionEditorSignals$ = computed(
  (get): TriggerPermissionEditorSignals | null => {
    const triggerId = get(triggerPermissionsTriggerId$);
    const ref = get(triggerPermissionsRef$);
    if (!triggerId || !ref) {
      return null;
    }
    return triggerPermissionEditorSignalsForKey(`${triggerId}\u0000${ref}`);
  },
);
