import { command, computed } from "ccstate";

import { db } from "../../lib/db";

export type Db = ReturnType<typeof db>;

type DbWriteMethod =
  | "insert"
  | "update"
  | "delete"
  | "execute"
  | "transaction"
  | "refreshMaterializedView"
  | "batch";

type ReadonlyDb = Omit<Db, DbWriteMethod>;

export const db$ = computed((): ReadonlyDb => {
  return db();
});

export const writeDb$ = command(() => {
  return db();
});
