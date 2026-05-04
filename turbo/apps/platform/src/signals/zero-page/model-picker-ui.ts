import { command, computed, state } from "ccstate";

// VM0 model dropdown collapse state. Module-scoped so the toggle persists
// across opens within a session and stays consistent between picker
// instances (composer, schedule dialog, settings).
const internalShowAllVm0Models$ = state(false);

export const showAllVm0Models$ = computed((get) => {
  return get(internalShowAllVm0Models$);
});

export const toggleShowAllVm0Models$ = command(({ get, set }) => {
  set(internalShowAllVm0Models$, !get(internalShowAllVm0Models$));
});
