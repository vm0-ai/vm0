import { computed } from "ccstate";

import { clerk } from "../../lib/clerk";

export const clerk$ = computed(() => {
  return clerk();
});
