import {
  type TestUserExportStateActionBody,
  testUserExportStateContract,
} from "@vm0/api-contracts/contracts/test-user-export-state";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { exportJobs } from "@vm0/db/schema/export-job";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testUserExportStateContract.action);
const DATA_EXPORT_READY_SUBJECT = "Your data export is ready";
const VM0_OUTBOX_FROM = "Zero <vm0@mail.example.com>";

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

function actionBadRequest(error: string) {
  return { status: 400 as const, body: { error } };
}

type UserExportStateAction = TestUserExportStateActionBody["action"];
type UserExportStateActionResponse =
  | ReturnType<typeof actionOk>
  | ReturnType<typeof actionBadRequest>;
type UserExportStateActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<UserExportStateActionResponse>;

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function deleteUserExportStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const userId = readString(body, "user_id");
  const email = readString(body, "email");
  if (!userId || !email) {
    return actionBadRequest("user_id and email are required");
  }

  await db.delete(emailOutbox).where(
    and(
      eq(emailOutbox.fromAddress, VM0_OUTBOX_FROM),
      eq(emailOutbox.subject, DATA_EXPORT_READY_SUBJECT),
      sql`(
        ${emailOutbox.toAddresses} = ${JSON.stringify(email)}::jsonb
        OR ${emailOutbox.toAddresses} @> ${JSON.stringify([email])}::jsonb
      )`,
    ),
  );
  signal.throwIfAborted();

  await db.delete(exportJobs).where(eq(exportJobs.userId, userId));
  signal.throwIfAborted();

  await db.delete(userCache).where(eq(userCache.userId, userId));
  signal.throwIfAborted();

  await db.delete(users).where(eq(users.id, userId));
  signal.throwIfAborted();

  return actionOk();
}

const userExportStateActionHandlers = {
  "delete-user-export-state": deleteUserExportStateForAction,
} satisfies Record<UserExportStateAction, UserExportStateActionHandler>;

const mutateTestUserExportState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data as Record<string, unknown>;
    return await userExportStateActionHandlers[bodyResult.data.action](
      set(writeDb$),
      body,
      signal,
    );
  },
);

export const testUserExportStateRoutes: readonly RouteEntry[] = [
  {
    route: testUserExportStateContract.action,
    handler: mutateTestUserExportState$,
  },
];
