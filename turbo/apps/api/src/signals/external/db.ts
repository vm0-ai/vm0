import { computed } from "ccstate";

import { db } from "../../lib/db";

export const db$ = computed(() => {
  return db();
});
