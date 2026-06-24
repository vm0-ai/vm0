import { command, computed, state, type Command, type Computed } from "ccstate";
import type {
  UnattendedTriggerPermissionAction,
  UnattendedTriggerPermissionPolicy,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { pathParams$, searchParams$ } from "../route.ts";
import { workflowDetail } from "../workflows-page/workflows-signals.ts";

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

const triggerPermissionsWorkflowId$ = computed((get) => {
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

/**
 * The unattended default is "deny": a permission absent from the trigger's
 * policy is treated as denied until explicitly allowed.
 */
const UNATTENDED_PERMISSION_DEFAULT: UnattendedTriggerPermissionAction = "deny";

/**
 * Resolve the current action for a single connector permission from the
 * trigger's full policy, falling back to the unattended default.
 */
export function resolveTriggerPermissionAction(
  policy: UnattendedTriggerPermissionPolicy | null,
  connectorRef: string,
  permission: string,
): UnattendedTriggerPermissionAction {
  return (
    policy?.[connectorRef]?.policies[permission] ??
    UNATTENDED_PERMISSION_DEFAULT
  );
}

/**
 * Merge an edited connector's permission map into the trigger's full existing
 * policy, preserving every other connector. Permissions set back to the
 * unattended default are dropped so the stored policy stays minimal; a
 * connector left with no explicit permissions is removed entirely, and an empty
 * overall policy collapses to `null` (which clears the policy server-side).
 */
export function mergeConnectorPolicy(
  policy: UnattendedTriggerPermissionPolicy | null,
  connectorRef: string,
  policies: Record<string, UnattendedTriggerPermissionAction>,
): UnattendedTriggerPermissionPolicy | null {
  const next: UnattendedTriggerPermissionPolicy = {};
  for (const [ref, entry] of Object.entries(policy ?? {})) {
    if (ref !== connectorRef) {
      next[ref] = entry;
    }
  }
  const nextPolicies: Record<string, UnattendedTriggerPermissionAction> = {};
  for (const [permission, action] of Object.entries(policies)) {
    if (action !== UNATTENDED_PERMISSION_DEFAULT) {
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
    // The factory is created per (triggerId, ref); ccstate's memoization keys
    // this computed on those route values, so navigating to a different
    // trigger/connector yields a fresh editor with no carried-over edits.
    return createTriggerPermissionEditorSignals();
  },
);
