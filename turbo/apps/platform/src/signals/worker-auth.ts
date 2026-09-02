import { computed } from "ccstate";

import { startClerkWorkerRuntime } from "../lib/clerk-worker-runtime.ts";

export const clerk$ = computed(() => {
  return startClerkWorkerRuntime();
});
