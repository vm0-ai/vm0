import { command, computed, state } from "ccstate";

export type LabSort = "name" | "maintainer" | "enabled";
export const LAB_ALL_MAINTAINERS = "__all__";
export type LabMaintainerFilter = string;

const internalLabSort$ = state<LabSort>("name");
const internalLabMaintainerFilter$ =
  state<LabMaintainerFilter>(LAB_ALL_MAINTAINERS);

export const labSort$ = computed((get): LabSort => {
  return get(internalLabSort$);
});

export const labMaintainerFilter$ = computed((get): LabMaintainerFilter => {
  return get(internalLabMaintainerFilter$);
});

export const setLabSort$ = command(({ set }, sort: LabSort) => {
  set(internalLabSort$, sort);
});

export const setLabMaintainerFilter$ = command(
  ({ set }, filter: LabMaintainerFilter) => {
    set(internalLabMaintainerFilter$, filter);
  },
);
