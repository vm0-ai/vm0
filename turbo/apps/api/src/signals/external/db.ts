import { computed } from "ccstate";

import { getDb } from "../../lib/db";

export const db$ = computed(() => {
  return getDb();
});
