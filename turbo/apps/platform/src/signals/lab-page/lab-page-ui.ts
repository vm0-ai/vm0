import { command, computed, state } from "ccstate";

export type LabSort = "name" | "maintainer" | "enabled";

const internalLabSort$ = state<LabSort>("name");

export const labSort$ = computed((get): LabSort => {
  return get(internalLabSort$);
});

export const setLabSort$ = command(({ set }, sort: LabSort) => {
  set(internalLabSort$, sort);
});
