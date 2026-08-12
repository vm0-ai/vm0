import { command } from "ccstate";
import {
  testUserConfigStateContract,
  type TestUserConfigStateActionBody,
} from "@vm0/api-contracts/contracts/test-user-config-state";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq, isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { encryptStoredSecretValue } from "../services/crypto.utils";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(testUserConfigStateContract.action);

/**
 * Plain user secrets and variables have no write API — `zero secret` and
 * `zero variable` were retired with the unreachable management routes (#25011)
 * and no web UI ever replaced them. Existing rows still drive run environment
 * injection and the Slack / Teams / Telegram readiness checks, so route tests
 * need a seam to seed and inspect them without resurrecting a production
 * surface. API tests mount this route explicitly through `setupApp`; deployed
 * applications never register it.
 */
type UserConfigStateAction<
  TAction extends TestUserConfigStateActionBody["action"],
> = Extract<TestUserConfigStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

async function setSecret(
  db: Db,
  body: UserConfigStateAction<"set-secret">,
  signal: AbortSignal,
) {
  const encryptedValue = await encryptStoredSecretValue(body.value);
  signal.throwIfAborted();
  await db
    .insert(secrets)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      name: body.name,
      encryptedValue,
      description: body.description ?? null,
      type: "user",
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      targetWhere: isNull(secrets.connectorId),
      set: {
        encryptedValue,
        description: body.description ?? null,
        updatedAt: nowDate(),
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function setVariable(
  db: Db,
  body: UserConfigStateAction<"set-variable">,
  signal: AbortSignal,
) {
  await db
    .insert(variables)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      name: body.name,
      value: body.value,
      description: body.description ?? null,
      type: "user",
    })
    .onConflictDoUpdate({
      target: [
        variables.orgId,
        variables.userId,
        variables.type,
        variables.name,
      ],
      targetWhere: isNull(variables.connectorId),
      set: {
        value: body.value,
        description: body.description ?? null,
        updatedAt: nowDate(),
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function listSecrets(
  db: Db,
  body: UserConfigStateAction<"list-secrets">,
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      name: secrets.name,
      type: secrets.type,
      description: secrets.description,
      connectorId: secrets.connectorId,
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .where(
      and(eq(secrets.orgId, body.org_id), eq(secrets.userId, body.user_id)),
    )
    .orderBy(secrets.name);
  signal.throwIfAborted();
  return actionOk({
    secrets: rows.map((row) => {
      return {
        name: row.name,
        type: row.type,
        description: row.description,
        connector_id: row.connectorId,
        encrypted_value: row.encryptedValue,
      };
    }),
  });
}

const mutateUserConfigState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "set-secret": {
        return await setSecret(db, body, signal);
      }
      case "set-variable": {
        return await setVariable(db, body, signal);
      }
      case "list-secrets": {
        return await listSecrets(db, body, signal);
      }
    }
  },
);

export const testUserConfigStateRoutes: readonly RouteEntry[] = [
  {
    route: testUserConfigStateContract.action,
    handler: mutateUserConfigState$,
  },
];
