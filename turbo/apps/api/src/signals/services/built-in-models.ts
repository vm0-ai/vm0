import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { computed } from "ccstate";
import { asc } from "drizzle-orm";

import { db$ } from "../external/db";

export const builtInModels$ = computed(async (get) => {
  const rows = await get(db$)
    .selectDistinct({ model: vm0ApiKeys.model })
    .from(vm0ApiKeys)
    .orderBy(asc(vm0ApiKeys.model));

  return rows.map((row) => {
    return row.model;
  });
});
