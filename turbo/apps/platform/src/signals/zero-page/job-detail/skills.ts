import { command, computed, state } from "ccstate";
import {
  zeroAgentsByIdContract,
  zeroSkillsCollectionContract,
  type ZeroAgentCustomSkill,
} from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { reloadJobDetail$, zeroJobDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Org-wide skills list (cached, used by the Skills tab on agent detail).
// ---------------------------------------------------------------------------

export const orgSkills$ = computed(
  async (get): Promise<ZeroAgentCustomSkill[]> => {
    const client = get(zeroClient$)(zeroSkillsCollectionContract);
    const result = await accept(client.list(), [200], { toast: false });
    return result.body;
  },
);

// ---------------------------------------------------------------------------
// Bound skills + optimistic toggle queue.
//
// Each agent has its own FIFO queue: at most one PUT in flight at a time.
// While a write is pending, additional toggles update an override map; when
// the in-flight write completes, the queue drains by computing the latest
// desired set from server-state + overrides, then issuing one final write
// that collapses any intermediate toggles.
// ---------------------------------------------------------------------------

const internalOverrides$ = state<Map<string, Map<string, boolean>>>(new Map());

/** Per-agent queue of pending writes. State signal so module-level mutation
 *  stays out of package scope. */
const internalWriteQueue$ = state<Map<string, Promise<void>>>(new Map());

function getOverridesFor(
  map: Map<string, Map<string, boolean>>,
  agentId: string,
): Map<string, boolean> {
  return map.get(agentId) ?? new Map();
}

export const boundCustomSkills$ = computed(
  async (get): Promise<Set<string>> => {
    const detail = await get(zeroJobDetail$);
    if (!detail) {
      return new Set();
    }
    const overrides = getOverridesFor(get(internalOverrides$), detail.agentId);
    const result = new Set<string>(detail.customSkills);
    for (const [name, enabled] of overrides) {
      if (enabled) {
        result.add(name);
      } else {
        result.delete(name);
      }
    }
    return result;
  },
);

/** Skill names with a pending optimistic toggle (UI shows row as busy). */
export const pendingSkillNames$ = computed(
  async (get): Promise<Set<string>> => {
    const detail = await get(zeroJobDetail$);
    if (!detail) {
      return new Set();
    }
    const overrides = getOverridesFor(get(internalOverrides$), detail.agentId);
    return new Set(overrides.keys());
  },
);

function setOverride(
  map: Map<string, Map<string, boolean>>,
  agentId: string,
  skillName: string,
  enabled: boolean,
): Map<string, Map<string, boolean>> {
  const next = new Map(map);
  const inner = new Map(next.get(agentId) ?? new Map<string, boolean>());
  inner.set(skillName, enabled);
  next.set(agentId, inner);
  return next;
}

function clearOverride(
  map: Map<string, Map<string, boolean>>,
  agentId: string,
  skillName: string,
): Map<string, Map<string, boolean>> {
  const inner = map.get(agentId);
  if (!inner || !inner.has(skillName)) {
    return map;
  }
  const next = new Map(map);
  const nextInner = new Map(inner);
  nextInner.delete(skillName);
  if (nextInner.size === 0) {
    next.delete(agentId);
  } else {
    next.set(agentId, nextInner);
  }
  return next;
}

function clearAllOverridesFor(
  map: Map<string, Map<string, boolean>>,
  agentId: string,
): Map<string, Map<string, boolean>> {
  if (!map.has(agentId)) {
    return map;
  }
  const next = new Map(map);
  next.delete(agentId);
  return next;
}

function setQueueFor(
  map: Map<string, Promise<void>>,
  agentId: string,
  promise: Promise<void>,
): Map<string, Promise<void>> {
  const next = new Map(map);
  next.set(agentId, promise);
  return next;
}

export const toggleAgentSkill$ = command(
  async (
    { get, set },
    args: { skillName: string; enabled: boolean },
    _signal: AbortSignal,
  ): Promise<void> => {
    const detail = await get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }
    const agentId = detail.agentId;

    // Optimistic update.
    set(internalOverrides$, (prev) => {
      return setOverride(prev, agentId, args.skillName, args.enabled);
    });

    const previous = get(internalWriteQueue$).get(agentId) ?? Promise.resolve();
    const next = previous.then(async () => {
      // Compute the latest desired set at the moment the queue slot is reached.
      // This collapses intermediate toggles for the same skill into the final
      // intended state.
      const latestDetail = await get(zeroJobDetail$);
      if (!latestDetail || latestDetail.agentId !== agentId) {
        return;
      }
      const overrides = getOverridesFor(get(internalOverrides$), agentId);
      const desired = new Set<string>(latestDetail.customSkills);
      for (const [name, enabled] of overrides) {
        if (enabled) {
          desired.add(name);
        } else {
          desired.delete(name);
        }
      }

      const client = get(zeroClient$)(zeroAgentsByIdContract);
      // On rejection, propagates to the queue tracker which reverts the override.
      await accept(
        client.update({
          params: { id: agentId },
          body: { customSkills: [...desired].sort() },
        }),
        [200],
      );
      // Persisted — clear overrides; the reload will pull authoritative state.
      set(internalOverrides$, (prev) => {
        return clearAllOverridesFor(prev, agentId);
      });
      set(reloadJobDetail$);
    });

    // Track at the queue level so subsequent toggles can chain after this one
    // even if it rejects. The failure handler also reverts the optimistic
    // override so the UI matches server state again.
    const tracked = next.then(
      () => {
        return undefined;
      },
      () => {
        set(internalOverrides$, (prev) => {
          return clearOverride(prev, agentId, args.skillName);
        });
        return undefined;
      },
    );
    set(internalWriteQueue$, (prev) => {
      return setQueueFor(prev, agentId, tracked);
    });
    await next;
  },
);

/** Reset toggle/queue state for a specific agent (called on agent switch). */
export const resetSkillToggleState$ = command(
  ({ set }, agentId: string | null) => {
    if (agentId !== null) {
      set(internalWriteQueue$, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
      set(internalOverrides$, (prev) => {
        return clearAllOverridesFor(prev, agentId);
      });
    } else {
      set(internalWriteQueue$, new Map());
      set(internalOverrides$, new Map());
    }
  },
);
