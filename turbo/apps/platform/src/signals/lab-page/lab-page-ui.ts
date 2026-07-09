import { command, computed, state } from "ccstate";

export const LAB_ALL_MAINTAINERS = "__all__";
export type LabMaintainerFilter = string;

const internalLabMaintainerFilter$ =
  state<LabMaintainerFilter>(LAB_ALL_MAINTAINERS);

export const labMaintainerFilter$ = computed((get): LabMaintainerFilter => {
  return get(internalLabMaintainerFilter$);
});

export const setLabMaintainerFilter$ = command(
  ({ set }, filter: LabMaintainerFilter) => {
    set(internalLabMaintainerFilter$, filter);
  },
);
