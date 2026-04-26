import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { asc } from "drizzle-orm";

import { getDb } from "../lib/db";

export async function listBuiltInModels(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ model: vm0ApiKeys.model })
    .from(vm0ApiKeys)
    .orderBy(asc(vm0ApiKeys.model));

  return rows.map((row) => {
    return row.model;
  });
}
