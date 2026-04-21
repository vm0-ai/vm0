import { command, computed, state, type StateArg } from "ccstate";
import type { CombinedEntry } from "../../views/zero-page/zero-schedule-page.tsx";
import { userPreferences$ } from "../zero-page/settings/user-preferences.ts";
import { agents$, agentById } from "../agent.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { orgModelProviders$ } from "../external/org-model-providers.ts";
import { createDefaultFormData, initDialogForm$ } from "./schedule-form.ts";

// ---------------------------------------------------------------------------
// Helper: creates a private state atom with exported computed (read) and
// command (write) pair, satisfying the no-export-state rule.
// ---------------------------------------------------------------------------

function cell<T>(initial: T) {
  const internal$ = state(initial);
  return Object.freeze({
    get$: computed((get) => {
      return get(internal$);
    }),
    set$: command(({ set }, value: StateArg<T>) => {
      set(internal$, value);
    }),
  });
}

// ---------------------------------------------------------------------------
// Schedule page UI state
// ---------------------------------------------------------------------------

const internalCreateDialogOpen$ = state(false);
export const createDialogOpen$ = computed((get) => {
  return get(internalCreateDialogOpen$);
});

/**
 * Computes the composer-seed model for a given agent. Priority: agent
 * default > org default > null. Mirrors the chat-composer priority chain
 * from PR #10431 so the schedule dialog's picker shows the exact model
 * the create body will carry.
 */
function scheduleComposerModelSeed$(agentId: string) {
  return computed(
    async (
      get,
    ): Promise<{ modelProviderId: string; selectedModel: string } | null> => {
      const agent = await get(agentById(agentId));
      if (agent?.modelProviderId && agent.selectedModel) {
        return {
          modelProviderId: agent.modelProviderId,
          selectedModel: agent.selectedModel,
        };
      }
      const { modelProviders } = await get(orgModelProviders$);
      const defaultProvider = modelProviders.find((p) => {
        return p.isDefault;
      });
      if (defaultProvider?.selectedModel) {
        return {
          modelProviderId: defaultProvider.id,
          selectedModel: defaultProvider.selectedModel,
        };
      }
      return null;
    },
  );
}

export const openCreateScheduleDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const [prefs, allAgents, status] = await Promise.all([
      get(userPreferences$),
      get(agents$),
      get(zeroOnboardingStatus$),
    ]);
    signal.throwIfAborted();
    const agentId = status?.defaultAgentId ?? allAgents[0]?.id;
    if (!agentId) {
      return;
    }
    // Priority: agent default > org default. Seeding here (rather than
    // letting the picker fall back to its null-value display) keeps the
    // model shown in the dialog identical to what the create body carries.
    // Without this seed, the picker would show the org default while the
    // backend resolved against the agent default — a display/run mismatch
    // mirroring the chat-composer issue fixed in PR #10431.
    const seed = await get(scheduleComposerModelSeed$(agentId));
    signal.throwIfAborted();
    const defaults = createDefaultFormData();
    set(initDialogForm$, {
      ...defaults,
      timezone: prefs?.timezone ?? defaults.timezone,
      agentId,
      modelProviderId: seed?.modelProviderId ?? null,
      selectedModel: seed?.selectedModel ?? null,
    });
    set(internalCreateDialogOpen$, true);
  },
);

export const closeCreateScheduleDialog$ = command(({ set }) => {
  set(internalCreateDialogOpen$, false);
});

export const { get$: creatingOrgSchedule$, set$: setCreatingOrgSchedule$ } =
  cell(false);

export const { get$: pageTogglingIds$, set$: setPageTogglingIds$ } = cell<
  Set<string>
>(new Set());

export const { get$: pageRunningIds$, set$: setPageRunningIds$ } = cell<
  Set<string>
>(new Set());

export const { get$: pagePendingDelete$, set$: setPagePendingDelete$ } =
  cell<CombinedEntry | null>(null);

// ---------------------------------------------------------------------------
// Calendar view state
// ---------------------------------------------------------------------------

const todayDayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;

export const { get$: calendarSelectedDay$, set$: setCalendarSelectedDay$ } =
  cell(todayDayIndex);

// ---------------------------------------------------------------------------
// Calendar entry popover open state
// ---------------------------------------------------------------------------

export const {
  get$: calendarPopoverEntryId$,
  set$: setCalendarPopoverEntryId$,
} = cell<string | null>(null);
