import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadRenameContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";

const renameBody$ = bodyResultOf(chatThreadRenameContract.rename);

const renameInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadRenameContract.rename));
  const body = await get(renameBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const writeDb = set(writeDb$);

  const updated = await writeDb
    .update(chatThreads)
    .set({ title: body.data.title, renamedAt: nowDate() })
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    )
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();

  if (updated.length === 0) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged(auth.userId);
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const zeroChatThreadRenameRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadRenameContract.rename,
    handler: authRoute({}, renameInner$),
  },
];
