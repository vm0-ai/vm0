import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { apiKeysByIdContract } from "@vm0/api-contracts/contracts/api-keys";
import { cliTokens } from "@vm0/db/schema/cli-tokens";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(apiKeysByIdContract.delete));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);
  const deleted = await writeDb
    .delete(cliTokens)
    .where(and(eq(cliTokens.id, params.id), eq(cliTokens.userId, auth.userId)))
    .returning({ id: cliTokens.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return notFound("API key not found");
  }
  return { status: 204 as const, body: undefined };
});

export const zeroApiKeysDeleteRoutes: readonly RouteEntry[] = [
  {
    route: apiKeysByIdContract.delete,
    handler: authRoute({}, deleteInner$),
  },
];
