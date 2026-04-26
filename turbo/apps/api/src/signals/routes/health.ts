import { computed } from "ccstate";

export const apiHealth$ = computed(() => {
  return { status: "ok" };
});
